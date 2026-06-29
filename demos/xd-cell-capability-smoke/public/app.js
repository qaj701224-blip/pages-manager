const runtimeOutput = document.querySelector('#runtime-output');
const runtimeDataOutput = document.querySelector('#runtime-data-output');
const routingOutput = document.querySelector('#routing-output');
const runtimeDataKeyInput = document.querySelector('#runtime-data-key');

document.addEventListener('click', async (event) => {
  const action = event.target?.dataset?.action;
  if (!action) return;

  try {
    if (action === 'health') return print(runtimeOutput, await getJson('/api/health'));
    if (action === 'env') return print(runtimeOutput, await getJson('/api/env'));
    if (action === 'echo') return print(routingOutput, await getJson('/api/echo?from=browser'));
    if (action === 'runtime-data') {
      return print(
        runtimeDataOutput,
        await getJson('/api/runtime-data/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: runtimeDataKeyInput.value }),
        })
      );
    }
  } catch (error) {
    print(runtimeOutput, { ok: false, error: error.message });
  }
});

async function getJson(path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  try {
    return {
      status: response.status,
      body: JSON.parse(text),
    };
  } catch {
    return {
      status: response.status,
      body: text,
    };
  }
}

function print(target, value) {
  target.textContent = JSON.stringify(value, null, 2);
}
