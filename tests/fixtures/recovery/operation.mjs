export default async function(input, context) {
  if (input.mode === 'overflow') return 'x'.repeat(1048577);
  if (input.mode === 'flood') { process.stdout.write('x'.repeat(262145)); await new Promise(resolve => setTimeout(resolve, 1000)); return {}; }
  const response = await fetch(input.url, { method: 'POST', body: JSON.stringify({ key: context.operationKey, attempt: context.attempt, tag: input.tag, hold: input.hold, holdAttempt: input.holdAttempt }) });
  if (!response.ok) throw new Error(`Receiver status ${response.status}`);
  const receipt = await response.json();
  if (input.fail && context.attempt < input.fail) throw new Error('Explicit retry fixture failure');
  return { attempt: context.attempt, operationKey: context.operationKey, ...receipt };
}
