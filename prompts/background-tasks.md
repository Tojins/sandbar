Before you declare a promise, verdict or final answer, stop every background task you started (servers, watchers, backgrounded shells), and never wait on a process with `pgrep -f`, which matches its own command line and so never finishes waiting.

Your session ends with your turn: a background task's completion notice will never reach you, so never end a turn to wait for one. Wait for a backgrounded command by polling its output file until it finishes, or rerun it in the foreground with a narrower scope.
