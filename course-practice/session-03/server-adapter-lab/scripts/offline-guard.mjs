// Accidentally replacing injected transport with global fetch fails locally.
// This is a regression guard, not an OS sandbox against edited hostile code.
globalThis.fetch=async()=>{throw Error('Network disabled in this teaching command. Use the injected scripted transport.');};
