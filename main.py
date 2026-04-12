"""Three-phase LLM + Monty CLI for ad-hoc expense data queries.

The conversation flow for each user turn has up to three phases:

  Phase 1 — Tool discovery (and direct answer when no tools needed)
    Send the user's prompt plus the OpenAI tool schemas to the model.
    If the model returns tool calls we know data-fetching is required
    and we proceed to Phase 2.  If it responds with plain text instead,
    that text is used directly as the final answer — no further LLM
    calls are made for this turn.

  Phase 2 — Code generation and execution  [only when tools needed]
    Ask the model to write Python code that uses the available tool
    functions to fetch and process the data needed to answer the prompt.
    The generated code runs inside a Monty sandbox that calls back to
    the real Python tool functions on the host.  The sandbox output
    becomes the ``<tool_results>`` context block.

  Phase 3 — Final answer  [only when tools needed]
    Re-send the original prompt augmented with the tool results (no
    tools array this time) to get a clean, data-grounded response.

Conversation history only retains the user's (possibly augmented)
prompt and the assistant's final reply, keeping the context window
tight as the conversation grows.
"""

import asyncio
import datetime
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import external_tools as tools
from openai import AsyncOpenAI

from pydantic_monty import Monty, MontyError, MontyRuntimeError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL = "gpt-4o-mini"

# System prompt used for Phase 1 (tool-discovery pass).
_PHASE1_SYSTEM = (
    "You are a helpful assistant that analyses team expense data. "
    "First check the conversation history — if ALL the data needed to answer the "
    "user's question is already present (e.g. in prior <tool_results> blocks), "
    "answer directly using that data without calling any tools. "
    "When tool calls are needed, apply an all-or-nothing rule for entity coverage: "
    "if the question requires data for a set of entities (e.g. all team members), "
    "either the COMPLETE set is already in context (answer directly) or you must "
    "fetch ALL of them — never issue tool calls for only a subset of entities "
    "because some are already in context."
)

# System prompt injected into Phase 2 to guide code generation.
_CODE_GEN_SYSTEM = f"""\
You are a Python code generator for a sandboxed interpreter.

Write async Python code that calls the tool functions listed below to
fetch the data required to answer the user's question, then returns a
dict or list summarising the answer.

Available functions (type stubs):
```python
{tools.MONTY_TOOLS}
```

Rules:
- Use `await` for every function call.
- Always `import asyncio` at the top and use `asyncio.gather()` to parallelise
  independent calls.
- The *last expression* in the code is the return value — do NOT use `return`,
  and do NOT end with an assignment (e.g. `result = x` returns null; write
  just `x` as the final line instead). The result must NEVER be null/None —
  always return a dict or list.
- NEVER use `def` or `async def` — not even a helper. Every `await` must
  appear at the top level. If you need to gather results, call
  `asyncio.gather(...)` directly at the top level, not inside a function.
- You may NOT import third-party libraries.
- Available stdlib: builtins, `sys`, `typing`, `asyncio`, `json`, `re`, `math`,
  `datetime`, `collections`, `itertools`, `functools`.
- Do NOT use `next()` — find the first match with a `for` loop and `break` instead.
- When filtering or searching text fields (descriptions, names, etc.) always use
  case-insensitive substring matching: `'term' in field.lower()`. Never use `==`
  to match a name or keyword — the data may contain full names like 'Bob Smith'
  where an equality check against 'bob' would silently return nothing.
- Always compute totals and subtotals using `sum_amounts` and include them in the
  returned dict or list. Never leave arithmetic to the final answer phase — if you
  return a list of expense items, wrap it: `{{"items": [...], "total": await sum_amounts(items)}}`.

Reply with ONLY a fenced ```python code block and nothing else.\
"""

# System prompt for Phase 3 (final natural-language answer).
_FINAL_SYSTEM = (
    "You are a helpful assistant analysing team expense data. "
    "Answer the user's question concisely and precisely, using the "
    "data provided in the <tool_results> block as your source of truth."
)


# ---------------------------------------------------------------------------
# Session logging
# ---------------------------------------------------------------------------


class SessionLog:
    """Writes a timestamped, human-readable log of the session to disk.

    Each entry is flushed immediately so the file is readable mid-session.
    Per-turn token and timing statistics are accumulated and written as a
    subtotal at the end of each turn; session-level grand totals are written
    by ``close()``.
    """

    def __init__(self) -> None:
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.path = Path(f"session_{ts}.log")
        self._file = self.path.open("w", encoding="utf-8")
        self._write(
            f'=== Session started {datetime.datetime.now().isoformat(timespec="seconds")} ===\n'
        )
        self._reset_turn()
        # Session-level accumulators
        self._s_turns = 0
        self._s_tokens = 0
        self._s_code_gen_tokens = 0  # Phase 2 LLM tokens only
        self._s_non_code_tokens = 0  # Phase 1 + Phase 3 tokens
        self._s_llm = 0.0
        self._s_code = 0.0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _write(self, text: str) -> None:
        self._file.write(text)
        self._file.flush()

    def _ts(self) -> str:
        return datetime.datetime.now().strftime("%H:%M:%S")

    def _reset_turn(self) -> None:
        self._p1 = {"pt": 0, "ct": 0, "llm": 0.0}
        self._p2 = {"pt": 0, "ct": 0, "llm": 0.0, "code": 0.0, "attempts": 0}
        self._p3 = {"pt": 0, "ct": 0, "llm": 0.0}

    # ------------------------------------------------------------------
    # Narrative log entries (existing behaviour)
    # ------------------------------------------------------------------

    def user_turn(self, prompt: str) -> None:
        self._write(f'\n{"─" * 60}\n[{self._ts()}] USER: {prompt}\n')

    def phase1(self, tool_calls: list[dict[str, object]] | None) -> None:
        if tool_calls:
            calls = ", ".join(str(tc["name"]) for tc in tool_calls)
            self._write(f"[{self._ts()}] PHASE 1 — tools: {calls}\n")
        else:
            self._write(f"[{self._ts()}] PHASE 1 — no tools needed\n")

    def phase2_code(self, attempt: int, code: str) -> None:
        self._write(
            f"[{self._ts()}] PHASE 2 attempt {attempt} — generated code:\n"
            f"```python\n{code}\n```\n"
        )

    def phase2_error(self, attempt: int, error: str) -> None:
        self._write(f"[{self._ts()}] PHASE 2 attempt {attempt} — error:\n{error}\n")

    def phase2_result(self, json_result: str) -> None:
        self._write(f"[{self._ts()}] PHASE 2 — result:\n{json_result}\n")

    def assistant(self, reply: str) -> None:
        self._write(f"[{self._ts()}] ASSISTANT: {reply}\n")

    # ------------------------------------------------------------------
    # Token / timing accumulators
    # ------------------------------------------------------------------

    def record_phase1(
        self, prompt_tokens: int, completion_tokens: int, llm_seconds: float
    ) -> None:
        self._p1["pt"] = prompt_tokens
        self._p1["ct"] = completion_tokens
        self._p1["llm"] = llm_seconds

    def record_phase2_llm(
        self, prompt_tokens: int, completion_tokens: int, llm_seconds: float
    ) -> None:
        self._p2["pt"] += prompt_tokens
        self._p2["ct"] += completion_tokens
        self._p2["llm"] += llm_seconds
        self._p2["attempts"] += 1

    def record_phase2_code(self, code_seconds: float) -> None:
        self._p2["code"] = code_seconds
        self._write(f"[{self._ts()}] PHASE 2 — code exec: {code_seconds:.3f}s\n")

    def record_phase3(
        self, prompt_tokens: int, completion_tokens: int, llm_seconds: float
    ) -> None:
        self._p3["pt"] = prompt_tokens
        self._p3["ct"] = completion_tokens
        self._p3["llm"] = llm_seconds

    # ------------------------------------------------------------------
    # Turn subtotals and session close
    # ------------------------------------------------------------------

    def end_turn(self) -> None:
        """Write per-turn stats, accumulate into session totals, reset."""
        p1, p2, p3 = self._p1, self._p2, self._p3

        lines: list[str] = []

        p1_total = p1["pt"] + p1["ct"]
        if p1_total:
            lines.append(
                f"  phase 1 : {p1_total:>6,} tokens "
                f"({p1['pt']}p + {p1['ct']}c)  {p1['llm']:.2f}s LLM"
            )

        p2_total = p2["pt"] + p2["ct"]
        if p2["attempts"]:
            n = p2["attempts"]
            code_str = f"  {p2['code']:.3f}s code" if p2["code"] > 0 else ""
            lines.append(
                f"  phase 2 : {p2_total:>6,} tokens "
                f"({p2['pt']}p + {p2['ct']}c, {n} attempt{'s' if n > 1 else ''}) "
                f" {p2['llm']:.2f}s LLM{code_str}"
            )

        p3_total = p3["pt"] + p3["ct"]
        if p3_total:
            lines.append(
                f"  phase 3 : {p3_total:>6,} tokens "
                f"({p3['pt']}p + {p3['ct']}c)  {p3['llm']:.2f}s LLM"
            )

        turn_tokens = p1_total + p2_total + p3_total
        turn_non_code = p1_total + p3_total
        turn_llm = p1["llm"] + p2["llm"] + p3["llm"]
        turn_code = p2["code"]

        lines.append(
            f"  subtotal: {turn_tokens:>6,} tokens  "
            f"(code-gen: {p2_total:,}  non-code: {turn_non_code:,})  "
            f"{turn_llm:.2f}s LLM  {turn_code:.3f}s code"
        )

        self._write(f"[{self._ts()}] TURN STATS:\n" + "\n".join(lines) + "\n")

        # Accumulate into session totals
        self._s_turns += 1
        self._s_tokens += turn_tokens
        self._s_code_gen_tokens += p2_total
        self._s_non_code_tokens += turn_non_code
        self._s_llm += turn_llm
        self._s_code += turn_code

        self._reset_turn()

    def close(self, history: list[dict[str, str]]) -> None:
        n = self._s_turns
        self._write(
            f"\nSESSION TOTALS — {n} turn{'s' if n != 1 else ''} | "
            f"{self._s_tokens:,} tokens total "
            f"(code-gen: {self._s_code_gen_tokens:,}  non-code: {self._s_non_code_tokens:,}) | "
            f"{self._s_llm:.2f}s LLM | "
            f"{self._s_code:.3f}s code\n"
        )
        # Conversation history section
        self._write(f'\n{"═" * 60}\nCONVERSATION HISTORY\n{"═" * 60}\n')
        for i, msg in enumerate(history):
            label = "USER" if msg["role"] == "user" else "ASSISTANT"
            turn_num = i // 2 + 1
            self._write(f"\n[Turn {turn_num}] {label}:\n{msg['content']}\n")
        self._write(f'{"═" * 60}\n')
        self._write(
            f'\n=== Session ended {datetime.datetime.now().isoformat(timespec="seconds")} ===\n'
        )
        self._file.close()
        print(f"\nSession log saved to: {self.path}")


# ---------------------------------------------------------------------------
# Conversation state
# ---------------------------------------------------------------------------


@dataclass
class Conversation:
    """Maintains the rolling message history for an ongoing dialogue.

    Only the user's (possibly tool-augmented) prompt and the assistant's
    final reply are stored — intermediate phase messages are discarded so
    the context window stays compact.
    """

    history: list[dict[str, str]] = field(default_factory=list)

    def add_turn(self, user_content: str, assistant_content: str) -> None:
        """Append a completed user/assistant exchange to the history."""
        self.history.append({"role": "user", "content": user_content})
        self.history.append({"role": "assistant", "content": assistant_content})

    def messages(self, system: str, user_content: str) -> list[dict[str, str]]:
        """Build a full messages list: system prompt + history + current turn."""
        return (
            [{"role": "system", "content": system}]
            + self.history
            + [{"role": "user", "content": user_content}]
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_user_context(prompt: str, context: str) -> str:
    """Combine *prompt* with tool results into the augmented user message."""
    return f"{prompt}\n\n<tool_results>\n{context}\n</tool_results>"


def _extract_code(text: str) -> str | None:
    """Extract the first ```python (or ```py) fenced code block from *text*.

    Returns the code string without the fence markers, or ``None`` if no
    fenced block is found.
    """
    match = re.search(r"```(?:python|py)\s*\n(.*?)```", text, re.DOTALL)
    return match.group(1).strip() if match else None


# ---------------------------------------------------------------------------
# The three phases
# ---------------------------------------------------------------------------


async def phase1_tool_discovery(
    prompt: str,
    conversation: Conversation,
    client: AsyncOpenAI,
    log: SessionLog,
) -> list[dict[str, object]] | str:
    """Phase 1: Ask the model whether any tools are needed to answer *prompt*.

    Sends the current conversation history plus the tool schemas.  If the
    model issues tool calls we extract their names and parsed arguments and
    return them as a plain list of dicts.  If no tools are needed the model's
    text reply is returned directly as a string — the caller can use it as
    the final answer without a separate Phase 3 call.
    """
    t0 = time.monotonic()
    response = await client.chat.completions.create(
        model=MODEL,
        messages=conversation.messages(_PHASE1_SYSTEM, prompt),
        tools=tools.OPENAI_TOOLS,
        tool_choice="auto",
    )
    llm_seconds = time.monotonic() - t0

    if response.usage:
        log.record_phase1(
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
            llm_seconds,
        )

    message = response.choices[0].message
    if not message.tool_calls:
        return message.content or ""

    return [
        {
            "name": tc.function.name,
            "arguments": json.loads(tc.function.arguments),
        }
        for tc in message.tool_calls
    ]


_MAX_CODE_RETRIES = 4


async def phase2_generate_and_execute(
    prompt: str,
    tool_calls: list[dict[str, object]],
    client: AsyncOpenAI,
    log: SessionLog,
) -> str:
    """Phase 2: Generate Python code for *prompt* and run it via Monty.

    The code generator has the full set of available tool stubs (from
    ``_CODE_GEN_SYSTEM``) and decides for itself which functions to call based
    on the original prompt.  The generated code runs inside the Monty sandbox,
    which calls back to the real host functions in ``external_tools.TOOL_FUNCTIONS``.

    If the generated code fails to compile or execute, the error is fed back
    to the model and it is asked to fix the code (up to ``_MAX_CODE_RETRIES``
    total attempts).

    Args:
        prompt: The original user question.
        tool_calls: Tool calls identified by Phase 1, with already-resolved
            arguments (e.g. resolved user IDs, names).  Used as a hint to avoid
            redundant lookups in the generated code.
        client: Async OpenAI client.
        log: Session log to record generated code, errors, and results.

    Returns:
        A JSON string representation of the Monty execution result, suitable
        for embedding as ``<tool_results>`` context in Phase 3.

    Raises:
        ValueError: If the model did not return a code block, or if Monty
            fails to compile or execute the generated code on all attempts.
    """
    calls_hint = "\n".join(
        "  - {}({})".format(
            tc["name"],
            ", ".join(f"{k}={v!r}" for k, v in tc["arguments"].items()),  # type: ignore[union-attr]
        )
        for tc in tool_calls
    )
    code_prompt = (
        f"User question: {prompt}\n\n"
        f"Phase 1 identified these tool calls as a starting point "
        f"(arguments already resolved from conversation context):\n"
        f"{calls_hint}\n\n"
        "Using the available functions listed above, fetch all data needed "
        "to answer the question, then filter and process the results so the "
        "returned value directly answers the question. "
        "Prefer using the Phase 1 argument values directly — avoid redundant "
        "lookups to resolve IDs or names that are already provided above.\n\n"
        "Write the code now."
    )

    messages: list[dict[str, str]] = [
        {"role": "system", "content": _CODE_GEN_SYSTEM},
        {"role": "user", "content": code_prompt},
    ]

    last_error: str = ""
    for attempt in range(1, _MAX_CODE_RETRIES + 1):
        t0 = time.monotonic()
        response = await client.chat.completions.create(
            model=MODEL,
            messages=messages,
        )
        llm_seconds = time.monotonic() - t0

        if response.usage:
            log.record_phase2_llm(
                response.usage.prompt_tokens,
                response.usage.completion_tokens,
                llm_seconds,
            )

        raw = response.choices[0].message.content or ""
        code = _extract_code(raw)
        if not code:
            raise ValueError(f"Model did not return a code block:\n{raw}")

        log.phase2_code(attempt, code)

        # Deterministic pre-checks: catch forbidden patterns before compilation.
        if re.search(r"\bdef\s+\w", code):
            last_error = (
                "Code contains a `def` or `async def` statement, which is forbidden. "
                "All logic must be written as flat top-level async code. "
                "Move the function body inline and use `await` directly."
            )
            log.phase2_error(attempt, last_error)
        elif re.search(r"\bnext\s*\(", code):
            last_error = (
                "Code uses `next()`, which is not available. "
                "Find the first match with a `for` loop and `break` instead."
            )
            log.phase2_error(attempt, last_error)
        else:
            # Compile — catches syntax and type errors before running.
            try:
                m = Monty(code, type_check=True, type_check_stubs=tools.MONTY_TOOLS)
            except MontyError as exc:
                last_error = f"Monty compile error: {exc}"
                log.phase2_error(attempt, last_error)
            else:
                # Execute inside the sandbox with the real tool functions as callbacks.
                try:
                    t0 = time.monotonic()
                    result = await m.run_async(external_functions=tools.TOOL_FUNCTIONS)
                    code_seconds = time.monotonic() - t0
                    if result is None:
                        last_error = (
                            "Code returned null. The last expression must be a dict or list — "
                            "not None. This usually means all logic was wrapped inside a "
                            "`def` or `async def` that was never called, or the final line "
                            "was an assignment rather than a bare expression."
                        )
                        log.phase2_error(attempt, last_error)
                    else:
                        result_json = json.dumps(result, indent=2, default=str)
                        log.phase2_result(result_json)
                        log.record_phase2_code(code_seconds)
                        return result_json
                except MontyRuntimeError as exc:
                    last_error = f"Monty runtime error: {exc}"
                    log.phase2_error(attempt, last_error)

        if attempt < _MAX_CODE_RETRIES:
            print(
                f"[phase 2] attempt {attempt} failed ({last_error.splitlines()[0]}), retrying…",
                flush=True,
            )
            # Append the failed attempt and the error so the model can self-correct.
            messages.append({"role": "assistant", "content": raw})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"The code above failed with the following error:\n\n{last_error}\n\n"
                        "Fix the code and reply with ONLY a corrected ```python code block."
                    ),
                }
            )

    raise ValueError(
        f"Code generation failed after {_MAX_CODE_RETRIES} attempts: {last_error}"
    )


async def phase3_final_response(
    prompt: str,
    context: str,
    conversation: Conversation,
    client: AsyncOpenAI,
    log: SessionLog,
) -> str:
    """Phase 3: Generate the final natural-language answer.

    Augments the original prompt with the tool results and sends the full
    conversation history so the model can give a contextually aware reply.
    No tools are included — all required data is already in the context.

    Args:
        prompt: The original user question.
        context: JSON string produced by Phase 2.
        conversation: Rolling conversation history.
        client: Async OpenAI client.
        log: Session log for token / timing recording.

    Returns:
        The assistant's final reply as a plain string.
    """
    augmented = _build_user_context(prompt, context)
    t0 = time.monotonic()
    response = await client.chat.completions.create(
        model=MODEL,
        messages=conversation.messages(_FINAL_SYSTEM, augmented),
    )
    llm_seconds = time.monotonic() - t0

    if response.usage:
        log.record_phase3(
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
            llm_seconds,
        )

    return response.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


async def run_turn(
    prompt: str,
    conversation: Conversation,
    client: AsyncOpenAI,
    log: SessionLog,
) -> str:
    """Run one full conversation turn, executing all necessary phases.

    The result and the stored history entry always use the augmented prompt
    (with tool results when tools were invoked), so subsequent turns have
    the fetched data as context without needing to re-fetch it.

    Args:
        prompt: Raw user input for this turn.
        conversation: Mutable conversation state (updated in place).
        client: Async OpenAI client.
        log: Session log updated at each phase.

    Returns:
        The assistant's reply for this turn.
    """
    log.user_turn(prompt)

    print("[phase 1] checking for required tools…", flush=True)
    phase1_result = await phase1_tool_discovery(prompt, conversation, client, log)
    log.phase1(phase1_result if isinstance(phase1_result, list) else None)

    if isinstance(phase1_result, list):
        print("[phase 2] generating and executing code…", flush=True)
        try:
            context = await phase2_generate_and_execute(
                prompt, phase1_result, client, log
            )
        except ValueError as exc:
            # Surface the error so the user sees it; still proceed to Phase 3
            # with an error context so the model can acknowledge the failure.
            print(f"warning: {exc}", file=sys.stderr)
            context = f"Error fetching data: {exc}"

        print("[phase 3] generating final response…", flush=True)
        user_content = _build_user_context(prompt, context)
        reply = await phase3_final_response(prompt, context, conversation, client, log)
    else:
        # No tools needed — Phase 1 already answered directly, reuse its response.
        print("[phase 1] answered directly, skipping phases 2 & 3…", flush=True)
        reply = phase1_result
        user_content = prompt

    # Only the (possibly augmented) user message and the assistant reply are
    # retained — intermediate phase messages are not stored.
    conversation.add_turn(user_content, reply)
    log.assistant(reply)
    log.end_turn()
    return reply


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Run the interactive expense-analysis CLI.

    Reads prompts from stdin, runs each through the three-phase pipeline,
    and prints the assistant's reply.  Type 'quit' or press Ctrl+C to exit.
    """
    client = AsyncOpenAI()
    conversation = Conversation()
    log = SessionLog()

    print("Expense Analysis Assistant")
    print("Ask anything about the team's Q3 travel expenses.")
    print("Type 'quit' or press Ctrl+C to exit.\n")

    try:
        while True:
            try:
                prompt = input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye!")
                break

            if not prompt:
                continue
            if prompt.lower() in ("quit", "exit", "q"):
                print("Goodbye!")
                break

            try:
                reply = await run_turn(prompt, conversation, client, log)
            except Exception as exc:
                print(f"Error: {exc}", file=sys.stderr)
                continue

            print(f"\nAssistant: {reply}\n")
    finally:
        log.close(conversation.history)


if __name__ == "__main__":
    asyncio.run(main())
