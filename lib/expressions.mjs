// Safe expression and value helpers for DAP state debugging.
// Expressions are parsed here, never via eval or Function, so a client can only
// read named kernel state and combine it with arithmetic/comparison operators.

export function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function valueText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// setVariable receives a string; decode it without ever changing the variable's
// type, so IR state stays well-typed and malformed input is a typed error.
export function parseVariableValue(text, current) {
  if (typeof text !== 'string') return { error: 'value must be a string' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  const expected = valueKind(current);
  if (valueKind(value) !== expected) return { error: `expected ${expected}, got ${valueKind(value)}` };
  if (expected === 'number' && !Number.isFinite(value)) return { error: 'value must be a finite number' };
  return { value };
}

const COMPARISONS = ['==', '!=', '>=', '<=', '>', '<'];

function numberOperand(value, operator) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`${operator} expects numeric operands`);
}

export function evaluateExpression(text, state) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('expression must be a non-empty string');
  }
  const src = text;
  let pos = 0;
  const skip = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
  const rest = () => src.slice(pos);
  const fail = message => { throw new Error(`${message} at offset ${pos}`); };

  function primary() {
    skip();
    if (src[pos] === '(') {
      pos++;
      const inner = comparison();
      skip();
      if (src[pos] !== ')') fail('missing closing parenthesis');
      pos++;
      return inner;
    }
    if (src[pos] === '+' || src[pos] === '-') {
      const operator = src[pos++];
      const operand = numberOperand(primary(), `unary ${operator}`);
      return operator === '-' ? -operand : operand;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(rest());
    if (number) {
      pos += number[0].length;
      return Number(number[0]);
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest());
    if (name) {
      pos += name[0].length;
      if (!state || !Object.hasOwn(state, name[0])) fail(`unknown state name ${name[0]}`);
      return state[name[0]];
    }
    fail('unexpected token');
  }

  function multiplicative() {
    let left = primary();
    for (;;) {
      skip();
      const operator = src[pos];
      if (operator !== '*' && operator !== '/' && operator !== '%') return left;
      pos++;
      const right = numberOperand(primary(), operator);
      left = numberOperand(left, operator);
      if (operator === '*') left *= right;
      else if (operator === '/') left /= right;
      else left %= right;
      if (!Number.isFinite(left)) fail('non-finite result');
    }
  }

  function additive() {
    let left = multiplicative();
    for (;;) {
      skip();
      const operator = src[pos];
      if (operator !== '+' && operator !== '-') return left;
      pos++;
      const right = numberOperand(multiplicative(), operator);
      left = numberOperand(left, operator) + (operator === '-' ? -right : right);
      if (!Number.isFinite(left)) fail('non-finite result');
    }
  }

  function comparison() {
    const left = additive();
    skip();
    const operator = COMPARISONS.find(token => rest().startsWith(token));
    if (!operator) return left;
    pos += operator.length;
    const right = additive();
    switch (operator) {
      case '==': return left === right;
      case '!=': return left !== right;
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      default: fail('unsupported comparison');
    }
  }

  const result = comparison();
  skip();
  if (pos !== src.length) fail('unexpected trailing input');
  return result;
}

// Completions must offer only names the parser accepts, so probe the parser
// itself instead of duplicating its identifier grammar.
export function expressionIdentifiers(state) {
  if (!state) return [];
  return Object.keys(state).filter(name => {
    try {
      evaluateExpression(name, state);
      return true;
    } catch {
      return false;
    }
  }).sort();
}
