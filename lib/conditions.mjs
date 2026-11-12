const CONDITION = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

export function parseCondition(text) {
  if (typeof text !== 'string') return null;
  const match = CONDITION.exec(text);
  if (!match) return null;
  return { name: match[1], operator: match[2], value: Number(match[3]), text: text.trim() };
}

export function matchesCondition(condition, state) {
  if (!condition || !state || !Object.hasOwn(state, condition.name)) return false;
  const actual = state[condition.name];
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return false;
  switch (condition.operator) {
    case '==': return actual === condition.value;
    case '!=': return actual !== condition.value;
    case '>': return actual > condition.value;
    case '<': return actual < condition.value;
    case '>=': return actual >= condition.value;
    case '<=': return actual <= condition.value;
    default: return false;
  }
}
