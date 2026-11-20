// stdout is the MCP protocol channel: anything else printed there corrupts it. Route every console
// call to stderr. ES imports run before the importing module's own statements, so this lives in its
// own module and `server.ts` imports it first: even a dependency that logs at load time cannot
// break the session.
console.log = console.info = console.debug = console.error;
