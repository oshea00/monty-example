"""FastAPI SSE backend wrapping the three-phase monty-examples pipeline.

Each POST /api/chat streams Server-Sent Events describing the progress of
Phase 1 (tool discovery), Phase 2 (code generation + Monty execution with
retries), and Phase 3 (final answer).  The existing CLI (main.py) is not
modified; this module imports its phase functions and helpers directly.
"""

import json
import re
import time
import uuid
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic_monty import Monty, MontyError, MontyRuntimeError

import external_tools as tools
from main import (
    MODEL,
    Conversation,
    SessionLog,
    _CODE_GEN_SYSTEM,
    _MAX_CODE_RETRIES,
    _build_user_context,
    _extract_code,
    phase1_tool_discovery,
    phase3_final_response,
)

app = FastAPI(title="monty-examples API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://ui:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store: session_id → (Conversation, SessionLog, AsyncOpenAI)
_sessions: dict[str, tuple[Conversation, SessionLog, AsyncOpenAI]] = {}


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    session_id: str
    message: str


# ---------------------------------------------------------------------------
# SSE helpers
# ---------------------------------------------------------------------------


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# Streaming Phase 2 — replicates main.py:phase2_generate_and_execute with
# step_start / step_complete SSE events emitted between each attempt.
# ---------------------------------------------------------------------------


async def _stream_phase2(
    prompt: str,
    tool_calls: list[dict],
    conversation: Conversation,
    client: AsyncOpenAI,
    log: SessionLog,
    uid: str,
    result_holder: list[str],
) -> AsyncIterator[str]:
    calls_hint = "\n".join(
        "  - {}({})".format(
            tc["name"],
            ", ".join(f"{k}={v!r}" for k, v in tc["arguments"].items()),
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

    messages = conversation.messages(_CODE_GEN_SYSTEM, code_prompt)
    last_error: str = ""

    for attempt in range(1, _MAX_CODE_RETRIES + 1):
        gen_id = f"p2gen_{uid}_{attempt}"

        yield _sse({
            "type": "step_start",
            "name": "code_generation",
            "callId": gen_id,
            "input": {"attempt": attempt, "prompt": prompt[:200]},
        })

        t0 = time.monotonic()
        response = await client.chat.completions.create(
            model=MODEL,
            messages=messages,  # type: ignore[arg-type]
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
            last_error = "Model did not return a code block."
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_generation",
                "callId": gen_id,
                "output": {"code": raw, "status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        log.phase2_code(attempt, code)

        # Deterministic pre-checks
        if re.search(r"\bdef\s+\w", code):
            last_error = (
                "Code contains a `def` or `async def` statement, which is forbidden. "
                "All logic must be written as flat top-level async code."
            )
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_generation",
                "callId": gen_id,
                "output": {"code": code, "status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        if re.search(r"\bnext\s*\(", code):
            last_error = "Code uses `next()`, which is not available. Use a for loop with break instead."
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_generation",
                "callId": gen_id,
                "output": {"code": code, "status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        yield _sse({
            "type": "step_complete",
            "name": "code_generation",
            "callId": gen_id,
            "output": {"code": code, "status": "ok"},
        })

        # Execution step
        exec_id = f"p2exec_{uid}_{attempt}"
        yield _sse({
            "type": "step_start",
            "name": "code_execution",
            "callId": exec_id,
            "input": {"code": code, "attempt": attempt},
        })

        try:
            m = Monty(code, type_check=True, type_check_stubs=tools.MONTY_TOOLS)
        except MontyError as exc:
            last_error = f"Monty compile error: {exc}"
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_execution",
                "callId": exec_id,
                "output": {"status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        try:
            t0 = time.monotonic()
            result = await m.run_async(external_functions=tools.TOOL_FUNCTIONS)
            code_seconds = time.monotonic() - t0
        except MontyRuntimeError as exc:
            last_error = f"Monty runtime error: {exc}"
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_execution",
                "callId": exec_id,
                "output": {"status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        if result is None:
            last_error = (
                "Code returned null. The last expression must be a dict or list."
            )
            log.phase2_error(attempt, last_error)
            yield _sse({
                "type": "step_complete",
                "name": "code_execution",
                "callId": exec_id,
                "output": {"status": "error", "error": last_error},
            })
            if attempt < _MAX_CODE_RETRIES:
                messages.append({"role": "assistant", "content": raw})  # type: ignore[arg-type]
                messages.append({  # type: ignore[arg-type]
                    "role": "user",
                    "content": f"The code above failed with:\n\n{last_error}\n\nFix the code and reply with ONLY a corrected ```python code block.",
                })
            continue

        result_json = json.dumps(result, indent=2, default=str)
        log.phase2_result(result_json)
        log.record_phase2_code(code_seconds)

        yield _sse({
            "type": "step_complete",
            "name": "code_execution",
            "callId": exec_id,
            "output": {"result": result_json, "status": "ok"},
        })

        result_holder.append(result_json)
        return

    # All attempts exhausted — leave result_holder empty; caller handles it
    yield _sse({
        "type": "error",
        "message": f"Code generation failed after {_MAX_CODE_RETRIES} attempts: {last_error}",
    })


# ---------------------------------------------------------------------------
# Main turn stream
# ---------------------------------------------------------------------------


async def _stream_turn(
    prompt: str,
    conversation: Conversation,
    client: AsyncOpenAI,
    log: SessionLog,
) -> AsyncIterator[str]:
    uid = uuid.uuid4().hex[:8]
    log.user_turn(prompt)

    # Phase 1
    p1_id = f"p1_{uid}"
    yield _sse({
        "type": "step_start",
        "name": "phase1_discovery",
        "callId": p1_id,
        "input": {"prompt": prompt},
    })

    phase1_result = await phase1_tool_discovery(prompt, conversation, client, log)
    log.phase1(phase1_result if isinstance(phase1_result, list) else None)

    yield _sse({
        "type": "step_complete",
        "name": "phase1_discovery",
        "callId": p1_id,
        "output": phase1_result,
    })

    if isinstance(phase1_result, list):
        # Phase 2 — streaming with retries
        result_holder: list[str] = []
        async for chunk in _stream_phase2(
            prompt, phase1_result, conversation, client, log, uid, result_holder
        ):
            yield chunk

        if not result_holder:
            context = "Error: code generation failed."
        else:
            context = result_holder[0]

        # Phase 3
        p3_id = f"p3_{uid}"
        yield _sse({
            "type": "step_start",
            "name": "phase3_answer",
            "callId": p3_id,
            "input": {"prompt": prompt},
        })

        reply = await phase3_final_response(prompt, context, conversation, client, log)

        yield _sse({
            "type": "step_complete",
            "name": "phase3_answer",
            "callId": p3_id,
            "output": {"answer": reply},
        })

        user_content = _build_user_context(prompt, context)
    else:
        reply = phase1_result
        user_content = prompt

    conversation.add_turn(user_content, reply)
    log.assistant(reply)
    log.end_turn()

    yield _sse({"type": "text_delta", "text": reply})
    yield _sse({"type": "done"})


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/sessions")
async def create_session() -> dict:
    session_id = str(uuid.uuid4())
    client = AsyncOpenAI()
    conversation = Conversation()
    log = SessionLog()
    _sessions[session_id] = (conversation, log, client)
    return {"session_id": session_id}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    entry = _sessions.pop(session_id, None)
    if entry:
        conversation, log, _ = entry
        log.close(conversation.history)
    return {"ok": True}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    entry = _sessions.get(req.session_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Session not found. Create one first.")
    conversation, log, client = entry

    async def generate() -> AsyncIterator[bytes]:
        try:
            async for chunk in _stream_turn(req.message, conversation, client, log):
                yield chunk.encode()
        except Exception as exc:
            yield _sse({"type": "error", "message": str(exc)}).encode()

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=True)
