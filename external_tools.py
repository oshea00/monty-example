"""External tool functions for the callables example.

Provides the expense-analysis data and three async tool functions, plus utilities
to derive both the OpenAI function-calling schemas and the Monty type stubs from
those functions at runtime — so adding a new tool only requires writing the
annotated Python function.

Usage::

    from external_tools import TOOL_FUNCTIONS, OPENAI_TOOLS, TYPE_STUBS
"""

import inspect
from typing import Any, Union, get_type_hints

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

team_members = [
    {"id": 1, "name": "Alice Chen"},
    {"id": 2, "name": "Bob Smith"},
    {"id": 3, "name": "Carol Jones"},
    {"id": 4, "name": "David Kim"},
    {"id": 5, "name": "Eve Wilson"},
]

expenses: dict[int, list[dict[str, Any]]] = {
    1: [  # Alice — under budget
        {"date": "2024-07-15", "amount": 450.00, "description": "Flight to NYC"},
        {"date": "2024-07-16", "amount": 200.00, "description": "Hotel NYC"},
        {"date": "2024-07-17", "amount": 85.00, "description": "Meals NYC"},
        {"date": "2024-08-20", "amount": 380.00, "description": "Flight to Chicago"},
        {"date": "2024-08-21", "amount": 175.00, "description": "Hotel Chicago"},
        {"date": "2024-09-05", "amount": 520.00, "description": "Flight to Seattle"},
        {"date": "2024-09-06", "amount": 225.00, "description": "Hotel Seattle"},
        {"date": "2024-09-07", "amount": 95.00, "description": "Meals Seattle"},
    ],
    2: [  # Bob — over standard budget but has a custom budget
        {"date": "2024-07-01", "amount": 850.00, "description": "Flight to London"},
        {"date": "2024-07-02", "amount": 450.00, "description": "Hotel London"},
        {"date": "2024-07-03", "amount": 125.00, "description": "Meals London"},
        {"date": "2024-07-04", "amount": 450.00, "description": "Hotel London"},
        {"date": "2024-07-05", "amount": 120.00, "description": "Meals London"},
        {"date": "2024-08-10", "amount": 780.00, "description": "Flight to Tokyo"},
        {"date": "2024-08-11", "amount": 380.00, "description": "Hotel Tokyo"},
        {"date": "2024-08-12", "amount": 380.00, "description": "Hotel Tokyo"},
        {"date": "2024-08-13", "amount": 150.00, "description": "Meals Tokyo"},
        {"date": "2024-09-15", "amount": 920.00, "description": "Flight to Singapore"},
        {"date": "2024-09-16", "amount": 320.00, "description": "Hotel Singapore"},
        {"date": "2024-09-17", "amount": 320.00, "description": "Hotel Singapore"},
        {"date": "2024-09-18", "amount": 180.00, "description": "Meals Singapore"},
    ],
    3: [  # Carol — way over budget, no custom budget
        {"date": "2024-07-08", "amount": 1200.00, "description": "Flight to Paris"},
        {"date": "2024-07-09", "amount": 550.00, "description": "Hotel Paris"},
        {"date": "2024-07-10", "amount": 550.00, "description": "Hotel Paris"},
        {"date": "2024-07-11", "amount": 550.00, "description": "Hotel Paris"},
        {"date": "2024-07-12", "amount": 200.00, "description": "Meals Paris"},
        {"date": "2024-08-25", "amount": 1100.00, "description": "Flight to Sydney"},
        {"date": "2024-08-26", "amount": 480.00, "description": "Hotel Sydney"},
        {"date": "2024-08-27", "amount": 480.00, "description": "Hotel Sydney"},
        {"date": "2024-08-28", "amount": 480.00, "description": "Hotel Sydney"},
        {"date": "2024-08-29", "amount": 220.00, "description": "Meals Sydney"},
        {"date": "2024-09-20", "amount": 650.00, "description": "Flight to Denver"},
        {"date": "2024-09-21", "amount": 280.00, "description": "Hotel Denver"},
    ],
    4: [  # David — slightly under budget
        {"date": "2024-07-22", "amount": 420.00, "description": "Flight to Boston"},
        {"date": "2024-07-23", "amount": 190.00, "description": "Hotel Boston"},
        {"date": "2024-07-24", "amount": 75.00, "description": "Meals Boston"},
        {"date": "2024-08-05", "amount": 510.00, "description": "Flight to Austin"},
        {"date": "2024-08-06", "amount": 210.00, "description": "Hotel Austin"},
        {"date": "2024-08-07", "amount": 90.00, "description": "Meals Austin"},
        {"date": "2024-09-12", "amount": 480.00, "description": "Flight to Portland"},
        {"date": "2024-09-13", "amount": 195.00, "description": "Hotel Portland"},
        {"date": "2024-09-14", "amount": 85.00, "description": "Meals Portland"},
    ],
    5: [  # Eve — over standard budget, no custom budget
        {"date": "2024-07-03", "amount": 680.00, "description": "Flight to Miami"},
        {"date": "2024-07-04", "amount": 320.00, "description": "Hotel Miami"},
        {"date": "2024-07-05", "amount": 320.00, "description": "Hotel Miami"},
        {"date": "2024-07-06", "amount": 145.00, "description": "Meals Miami"},
        {"date": "2024-08-18", "amount": 750.00, "description": "Flight to San Diego"},
        {"date": "2024-08-19", "amount": 290.00, "description": "Hotel San Diego"},
        {"date": "2024-08-20", "amount": 290.00, "description": "Hotel San Diego"},
        {"date": "2024-08-21", "amount": 130.00, "description": "Meals San Diego"},
        {"date": "2024-09-08", "amount": 820.00, "description": "Flight to Las Vegas"},
        {"date": "2024-09-09", "amount": 380.00, "description": "Hotel Las Vegas"},
        {"date": "2024-09-10", "amount": 380.00, "description": "Hotel Las Vegas"},
        {"date": "2024-09-11", "amount": 175.00, "description": "Meals Las Vegas"},
    ],
}

# Only Bob has a custom budget (international travel).
custom_budgets: dict[int, dict[str, Any]] = {
    2: {"amount": 7000.00, "reason": "International travel required"},
}


# ---------------------------------------------------------------------------
# Tool functions
# ---------------------------------------------------------------------------


async def get_team_members(department: str) -> dict[str, Any]:
    """Get the list of team members for a department.

    Args:
        department: The department name (e.g. 'Engineering').

    Returns:
        A dict with keys 'department' and 'members' (list of {id, name}).
    """
    return {"department": department, "members": team_members}


async def get_expenses(user_id: int, quarter: str, category: str) -> dict[str, Any]:
    """Get expense line items for a specific team member.

    Args:
        user_id: The member's numeric ID.
        quarter: The quarter label (e.g. 'Q3').
        category: The expense category (e.g. 'travel').

    Returns:
        A dict with keys 'user_id', 'quarter', 'category', and 'expenses'
        (list of {date, amount, description}).
    """
    items = expenses.get(user_id, [])
    return {
        "user_id": user_id,
        "quarter": quarter,
        "category": category,
        "expenses": items,
    }


async def sum_amounts(items: list[dict[str, Any]], field: str = "amount") -> float:
    """Sum a numeric field across a list of dicts.

    Args:
        items: A list of dicts each containing the field to sum (e.g. expense records).
        field: The key whose values are summed (default: 'amount').

    Returns:
        The sum as a float.
    """
    return sum(float(item[field]) for item in items)


async def get_custom_budget(user_id: int) -> dict[str, Any] | None:
    """Get the custom budget for a team member, if one exists.

    Args:
        user_id: The member's numeric ID.

    Returns:
        A dict with keys 'user_id', 'budget', and 'reason', or None if the
        member uses the standard budget.
    """
    info = custom_budgets.get(user_id)
    if info:
        return {"user_id": user_id, "budget": info["amount"], "reason": info["reason"]}
    return None


# ---------------------------------------------------------------------------
# Runtime schema / stub generation
# ---------------------------------------------------------------------------

# Callable registry — passed directly to Monty as `external_functions`.
TOOL_FUNCTIONS: dict[str, Any] = {
    "get_team_members": get_team_members,
    "get_expenses": get_expenses,
    "get_custom_budget": get_custom_budget,
    "sum_amounts": sum_amounts,
}


def _hint_to_json_type(hint: Any) -> str:
    """Map a Python type hint to the closest JSON Schema primitive type.

    Complex generics (dict, list, Union, etc.) fall back to 'string' because
    OpenAI tool schemas only need to communicate the broad shape to the model.
    """
    # Unwrap Optional[X] → X (Union[X, None])
    origin = getattr(hint, "__origin__", None)
    if origin is Union:
        args = [a for a in hint.__args__ if a is not type(None)]
        if args:
            return _hint_to_json_type(args[0])

    if hint is int:
        return "integer"
    if hint is float:
        return "number"
    if hint is bool:
        return "boolean"
    if origin in (dict, list) or hint in (dict, list):
        return "object" if (origin is dict or hint is dict) else "array"
    # str, Any, and everything else
    return "string"


def _type_to_stub(hint: Any) -> str:
    """Convert a type hint object to its Python stub string representation.

    Produces compact output like 'dict[str, Any]' or 'dict[str, Any] | None'.
    """
    origin = getattr(hint, "__origin__", None)
    args = getattr(hint, "__args__", ())

    if origin is Union:
        parts = [_type_to_stub(a) for a in args]
        # Collapse None into the | None shorthand
        non_none = [p for p in parts if p != "None"]
        if len(parts) != len(non_none):
            return " | ".join(non_none) + " | None"
        return " | ".join(parts)

    if origin is not None:
        origin_name = getattr(origin, "__name__", str(origin))
        if args:
            return f"{origin_name}[{', '.join(_type_to_stub(a) for a in args)}]"
        return origin_name

    if hint is type(None):
        return "None"
    return getattr(hint, "__name__", str(hint))


def _parse_docstring_params(doc: str) -> dict[str, str]:
    """Extract parameter descriptions from a Google-style docstring.

    Returns a mapping of parameter name → description.
    """
    descriptions: dict[str, str] = {}
    in_args = False
    for line in doc.splitlines():
        stripped = line.strip()
        if stripped == "Args:":
            in_args = True
            continue
        if in_args:
            if stripped and not stripped[0].isspace() and stripped.endswith(":"):
                # New top-level section — stop parsing args
                break
            # Lines like "    param_name: Description text."
            if ":" in stripped:
                name, _, desc = stripped.partition(":")
                descriptions[name.strip()] = desc.strip()
    return descriptions


def build_openai_tools(*fns: Any) -> list[dict[str, Any]]:
    """Build OpenAI function-calling tool schemas from annotated async functions.

    Derives parameter names, types, and descriptions from the function's type
    annotations and Google-style docstring so that adding a new tool only
    requires writing the Python function — no separate schema maintenance.

    Args:
        *fns: The async tool functions to include.

    Returns:
        A list of OpenAI-compatible tool dicts suitable for the ``tools``
        parameter of ``chat.completions.create``.
    """
    tools = []
    for fn in fns:
        hints = get_type_hints(fn)
        sig = inspect.signature(fn)
        doc = inspect.getdoc(fn) or ""
        first_line = doc.split("\n")[0]
        param_docs = _parse_docstring_params(doc)

        properties: dict[str, Any] = {}
        required: list[str] = []

        for name, param in sig.parameters.items():
            json_type = _hint_to_json_type(hints.get(name, str))
            prop: dict[str, Any] = {"type": json_type}
            if json_type == "array":
                prop["items"] = {"type": "object"}
            if name in param_docs:
                prop["description"] = param_docs[name]
            properties[name] = prop
            if param.default is inspect.Parameter.empty:
                required.append(name)

        tools.append(
            {
                "type": "function",
                "function": {
                    "name": fn.__name__,
                    "description": first_line,
                    "parameters": {
                        "type": "object",
                        "properties": properties,
                        "required": required,
                    },
                },
            }
        )
    return tools


def build_type_stubs(*fns: Any) -> str:
    """Build a Monty-compatible Python type stub string from annotated functions.

    The stubs are passed to ``Monty(type_check_stubs=...)`` so the type checker
    knows the signatures of external functions, and to the LLM as context so it
    generates correctly-typed calls.

    Args:
        *fns: The async tool functions to include.

    Returns:
        A ``from __future__`` / ``from typing import`` preamble followed by
        one ``async def`` stub per function.
    """
    lines = ["from typing import Any", ""]
    for fn in fns:
        hints = get_type_hints(fn)
        sig = inspect.signature(fn)
        doc = inspect.getdoc(fn) or ""

        params = [
            f"{name}: {_type_to_stub(hints.get(name, Any))}" for name in sig.parameters
        ]
        ret = _type_to_stub(hints.get("return", Any))

        lines.append(f"async def {fn.__name__}({', '.join(params)}) -> {ret}:")
        # Include docstring so the LLM understands what each function returns.
        for i, doc_line in enumerate(doc.splitlines()):
            if i == 0:
                lines.append(f'    """{doc_line}')
            else:
                lines.append(f"    {doc_line}")
        lines.append('    """')
        lines.append("    ...")
        lines.append("")

    return "\n".join(lines)


# Build once at import time so callers just reference the constants.
OPENAI_TOOLS: list[dict[str, Any]] = build_openai_tools(
    get_team_members, get_expenses, get_custom_budget, sum_amounts
)

MONTY_TOOLS: str = build_type_stubs(
    get_team_members, get_expenses, get_custom_budget, sum_amounts
)
