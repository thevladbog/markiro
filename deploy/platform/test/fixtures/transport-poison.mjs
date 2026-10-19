// Must never run before the workflow's sanitized Node startup.
process.stderr.write("UNTRUSTED_NODE_LOADER_EXECUTED\n");
process.exit(91);
