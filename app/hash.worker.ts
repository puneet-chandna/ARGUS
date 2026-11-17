self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const hash = await crypto.subtle.digest("SHA-256", await event.data.arrayBuffer());
    self.postMessage(Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""));
  } catch {
    self.postMessage(null);
  }
};
