export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      directAccess: 'Use nextId(env, prefix) from apps/pages-api/src/id.js instead of reading env.nextId directly.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (propertyName(node) === 'nextId') context.report({ node, messageId: 'directAccess' });
      },
      Property(node) {
        if (node.parent?.type === 'ObjectPattern' && propertyName(node) === 'nextId') {
          context.report({ node, messageId: 'directAccess' });
        }
      },
    };
  },
};

function propertyName(node) {
  const property = node.property || node.key;
  if (!property) return null;
  if (!node.computed && property.type === 'Identifier') return property.name;
  if (node.computed && property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}
