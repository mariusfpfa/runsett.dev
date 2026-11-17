export default async function(input, context) {
  context.log(JSON.stringify({ attempt: context.attempt, operationKey: context.operationKey }));
  if (context.attempt < (input.failBefore ?? 1)) throw new Error('Deliberate retry demonstration');
  return { ...input, attempt: context.attempt, operationKey: context.operationKey };
}
