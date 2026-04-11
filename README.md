# Callables — LLM + Monty Tool Calling

Demonstrates a conversation pattern for safely executing LLM-generated
Python code that calls host-side tool functions via [Monty](https://github.com/pydantic/monty). Monty is a Rust-based sandboxed Python runtime that compiles a subset of Python source into an internal bytecode format and interprets it in its own VM. When embedded, it runs in-process on the calling thread.

## How it works

```
User prompt
    │
    ▼
Phase 1 — Tool discovery (and direct answer when no tools needed)
    Send prompt + conversation history + OpenAI tool schemas to the model.
    If the required data is already in the conversation history, the model
    answers directly — no further LLM calls are made for this turn.
    If new data is needed, the model signals which tools are relevant.
    │
    ├─ no tools needed → answer returned, turn complete (1 LLM call)
    │
    ▼ only if new data is needed
Phase 2 — Code generation + Monty execution
    Ask the model to write Python code using the full set of tool type stubs.
    The model decides for itself which functions to call and how to combine
    results — loops, parallel asyncio.gather calls, aggregations.
    Execute code in the Monty sandbox → calls back to real host functions.
    If the generated code fails to compile or run, the error is fed back
    to the model and it retries (up to 4 attempts).
    Collect the JSON result as a <tool_results> context block.
    │
    ▼
Phase 3 — Final answer
    Send original prompt + tool results to model (no tools array).
    Model produces a data-grounded natural-language reply.

Conversation history retains only the (possibly augmented) user
prompt and the assistant reply — keeping context compact.
```

## Why this approach instead of direct tool calling?

Standard OpenAI tool calling executes one tool call at a time, round-tripping
to the model after each result.  The Monty approach lets the model write
arbitrarily complex orchestration logic — loops, parallel `asyncio.gather`
calls, aggregations — that runs entirely in the sandbox.  The host only sees
the final computed result, not every intermediate call.  This makes it
practical for questions that require fetching data for every team member in
parallel and then doing analysis over the combined results.

Phase 1 also checks whether the data is already present in the conversation
history before triggering a code-generation round-trip.  When no tools are
needed, Phase 1's response is used as the final answer directly — the turn
costs a single LLM call.  Follow-up questions such as "reformat that as a
table" or "what is the total?" are answered this way, saving tokens and
latency compared to making a redundant second call.

## Session log

Every run writes a timestamped `session_YYYYMMDD_HHMMSS.log` file recording:

- Each user prompt
- Phase 1 tool-discovery outcome
- Phase 2 generated code (every attempt), errors, and the JSON execution result
- Phase 3 final assistant reply
- Per-turn token accounting split into **code-gen** (Phase 2 LLM calls) vs
  **non-code** (Phase 1 + Phase 3) along with LLM and code execution times
- Session-level grand totals

Turns answered directly from Phase 1 show only a `phase 1` line in TURN STATS:

```
[12:39:01] TURN STATS:
  phase 1 :  6,812 tokens (6671p + 141c)  2.91s LLM
  subtotal:  6,812 tokens  (code-gen: 0  non-code: 6,812)  2.91s LLM  0.000s code
```

Turns that required new data show all three phases:

```
[12:38:09] TURN STATS:
  phase 1 :  5,990 tokens (5849p + 141c)  3.46s LLM
  phase 2 :    843 tokens (634p + 209c, 1 attempt)  4.24s LLM  0.002s code
  phase 3 :  6,978 tokens (6434p + 544c)  9.48s LLM
  subtotal: 13,811 tokens  (code-gen: 843  non-code: 12,968)  17.18s LLM  0.002s code
```

## Files

| File | Purpose |
|---|---|
| `external_tools.py` | Expense data, async tool functions, and runtime generation of OpenAI schemas and Monty type stubs from function signatures |
| `main.py` | Three-phase orchestration loop, session logging, and interactive CLI |

## Running

**With uv (recommended):**

```bash
uv sync
export OPENAI_API_KEY=sk-...
uv run python main.py
```

**With pip:**

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export OPENAI_API_KEY=sk-...
python main.py
```

## Sample session

The following is extracted from an actual session log.  It shows three
characteristic behaviours:

1. A data-fetch turn that triggers code generation (all flight expenses)
2. A reformatting turn answered directly from context — no tools called
3. A follow-up aggregation also answered from context

---

**Turn: fetch all flight expenses across the team**

Phase 1 detects that expense data is needed and triggers Phase 2.  The
generated code fetches all members in parallel, then filters descriptions
for the word "flight":

```python
import asyncio

department = 'Engineering'
quarter = 'Q3'
category = 'travel'

members_data = await get_team_members(department)
members = members_data['members']

expenses_tasks = []
for member in members:
    expenses_tasks.append(get_expenses(member['id'], quarter, category))

expenses_list = await asyncio.gather(*expenses_tasks)

filtered_expenses = []
for expenses in expenses_list:
    for expense in expenses['expenses']:
        if 'flight' in expense['description'].lower():
            filtered_expenses.append({
                'user_id': expenses['user_id'],
                'expense': expense
            })

filtered_expenses
```

Phase 3 renders the result as a named list:

```
Assistant: Here are all expenses containing "flight," organised by member:

1. Alice Chen (ID: 1)
   - 2024-07-15  $450.00   Flight to NYC
   - 2024-08-20  $380.00   Flight to Chicago
   - 2024-09-05  $520.00   Flight to Seattle

2. Bob Smith (ID: 2)
   - 2024-07-01  $850.00   Flight to London
   - 2024-08-10  $780.00   Flight to Tokyo
   - 2024-09-15  $920.00   Flight to Singapore

3. Carol Jones (ID: 3)
   - 2024-07-08  $1,200.00  Flight to Paris
   - 2024-08-25  $1,100.00  Flight to Sydney
   - 2024-09-20  $650.00    Flight to Denver

4. David Kim (ID: 4)
   - 2024-07-22  $420.00   Flight to Boston
   - 2024-08-05  $510.00   Flight to Austin
   - 2024-09-12  $480.00   Flight to Portland

5. Eve Wilson (ID: 5)
   - 2024-07-03  $680.00   Flight to Miami
   - 2024-08-18  $750.00   Flight to San Diego
   - 2024-09-08  $820.00   Flight to Las Vegas
```

---

**Turn: reformat as a markdown table**

Phase 1 recognises the data is already in the conversation history —
no tools are called, no code is generated, and Phase 1 answers directly:

```
[PHASE 1 — no tools needed, answered directly]
```

```
Assistant:

| Member Name  | ID | Date       | Amount    | Description         |
|--------------|----|------------|-----------|---------------------|
| Alice Chen   | 1  | 2024-07-15 | $450.00   | Flight to NYC       |
| Alice Chen   | 1  | 2024-08-20 | $380.00   | Flight to Chicago   |
| Alice Chen   | 1  | 2024-09-05 | $520.00   | Flight to Seattle   |
| Bob Smith    | 2  | 2024-07-01 | $850.00   | Flight to London    |
| Bob Smith    | 2  | 2024-08-10 | $780.00   | Flight to Tokyo     |
| Bob Smith    | 2  | 2024-09-15 | $920.00   | Flight to Singapore |
| Carol Jones  | 3  | 2024-07-08 | $1,200.00 | Flight to Paris     |
| Carol Jones  | 3  | 2024-08-25 | $1,100.00 | Flight to Sydney    |
| Carol Jones  | 3  | 2024-09-20 | $650.00   | Flight to Denver    |
| David Kim    | 4  | 2024-07-22 | $420.00   | Flight to Boston    |
| David Kim    | 4  | 2024-08-05 | $510.00   | Flight to Austin    |
| David Kim    | 4  | 2024-09-12 | $480.00   | Flight to Portland  |
| Eve Wilson   | 5  | 2024-07-03 | $680.00   | Flight to Miami     |
| Eve Wilson   | 5  | 2024-08-18 | $750.00   | Flight to San Diego |
| Eve Wilson   | 5  | 2024-09-08 | $820.00   | Flight to Las Vegas |
```

---

**Turn: total flight expenses by member**

Again Phase 1 sees the data already in context — no tools called, no code
generated, Phase 1 answers directly:

```
Assistant: Here are the total flight expenses by member:

1. Alice Chen (ID: 1)   — $1,350.00
2. Bob Smith (ID: 2)    — $2,550.00
3. Carol Jones (ID: 3)  — $2,950.00
4. David Kim (ID: 4)    — $1,410.00
5. Eve Wilson (ID: 5)   — $2,250.00
```

---

Session totals for conversation:

```
This table summarizes the total amount spent on flight-related expenses for each member.
[13:41:33] TURN STATS:
  phase 1 :  2,705 tokens (2567p + 138c)  2.49s LLM
  subtotal:  2,705 tokens  (code-gen: 0  non-code: 2,705)  2.49s LLM  0.000s code

SESSION TOTALS — 6 turns | 12,609 tokens total (code-gen: 2,380  non-code: 10,229) | 40.08s LLM | 0.013s code
```

The low code-gen token count (2,380 out of 12,609) reflects that data was
fetched only when genuinely needed.  The bulk of the tokens are in Phase 1
(which handles both tool-discovery and direct answers) and Phase 3 (final
answer on turns that fetched new data), where the growing conversation
history is passed to the model.  Performance-wise, almost all runtime was LLM
latency (40.08s) while code execution remained negligible (0.013s).

---

## When code generation goes wrong

The session log is the primary diagnostic tool.  Two characteristic failure
modes are shown below, both from a single session.

### Failure 1 — Assignment statement as last expression

**Prompt:** *"get the first expense line for Bob Smith and tell me the items on it"*

The generated code correctly located Bob Smith (user_id 2) and fetched his
expenses, but ended with an assignment statement rather than a bare expression:

```python
import asyncio

members_data = await get_team_members('Engineering')
members = members_data['members']

bob_id = None
for member in members:
    if 'bob smith' in member['name'].lower():
        bob_id = member['id']
        break

expenses_data = await get_expenses(bob_id, 'Q3', 'travel')
expenses = expenses_data['expenses']

first_expense = expenses[0] if expenses else None

result = first_expense   # ← assignment, not a bare expression
```

Monty evaluates the last expression as the return value.  An assignment
statement has no value, so the sandbox returned `null`.  Phase 3 received
`null` as its tool result and (correctly) reported that no expenses were found.

**Fix:** the code generation rules now explicitly require that the last line be
a bare expression, not an assignment — e.g. `first_expense` rather than
`result = first_expense`.

---

### Failure 2 — Over-fetching due to unnecessary parameter combinations

**Prompt:** *"try looking for user id 2"* (follow-up after the `null` result above)

With the user_id supplied directly, the model generated code that iterated
over all quarters and categories rather than making a single call:

```python
import asyncio

quarters = ['Q1', 'Q2', 'Q3', 'Q4']
categories = ['travel', 'meals', 'accommodation']

tasks = []
for quarter in quarters:
    for category in categories:
        tasks.append(get_expenses(2, quarter, category))

results = await asyncio.gather(*tasks)
```

Because `get_expenses` ignores the `quarter` and `category` arguments and
always returns the same full expense list, this produced 12 identical
responses — 572 lines of duplicate JSON.  Phase 3 received 5,620 prompt
tokens to answer what was a trivial single-call lookup.  The session log
made the cost immediately visible:

```
[TURN STATS]
  phase 1 :    ...
  phase 2 :  1,004 tokens (1 attempt)  ...
  phase 3 :  5,620p + ...
  subtotal:  7,229 tokens  (code-gen: 1,004  non-code: 6,225)  13.45s LLM
```

**Root cause:** the model learned from the Phase 2 type stubs that
`get_expenses` accepts `quarter` and `category` parameters, and assumed
(reasonably) that they were filters.  Because the stub does not signal that
the parameters are currently ignored, the model hedged by fetching all
combinations.

**Takeaway:** keep tool semantics honest in docstrings and stubs.  If a
parameter is accepted but not yet filtering, document that clearly so the
model does not over-fetch defensively.
