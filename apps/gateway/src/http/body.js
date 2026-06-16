export function parseJsonText(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

export async function readJson(request) {
  const text = await request.text();
  return parseJsonText(text);
}
