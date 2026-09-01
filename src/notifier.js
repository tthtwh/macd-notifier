const SERVERCHAN_ENDPOINT = 'https://sctapi.ftqq.com';

export async function sendServerChan({ sendKey, title, description, fetchImpl = fetch }) {
  if (!sendKey) throw new Error('缺少 SERVERCHAN_SENDKEY');

  const body = new URLSearchParams({ title, desp: description });
  const response = await fetchImpl(
    `${SERVERCHAN_ENDPOINT}/${encodeURIComponent(sendKey)}.send`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal: AbortSignal.timeout(15_000)
    }
  );
  if (!response.ok) throw new Error(`Server酱 HTTP ${response.status}`);

  const result = await response.json();
  if (result?.code !== 0) {
    throw new Error(`Server酱发送失败：${result?.message ?? `code=${result?.code}`}`);
  }
  return result;
}
