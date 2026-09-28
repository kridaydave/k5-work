# Phase 4: policy and persistence

Durable decisions behind the session store, ACP discovery, and continuation. Code
and tests carry the implementation; this file records only the choices that are not
recoverable by reading either.

## k5 owns the transcript, not the harness

The harness's own `session/load` replay is never drained into k5. k5 writes every
event it forwards to a local append-only log and reads that log back, so a transcript
is a k5 artifact with a stable identity.

The reason is that ACP has no replay terminator. `loadSession` replays, but nothing in
the protocol says it has finished, so treating a silent channel as "done" makes the
transcript a guess that truncates on a slow harness. The SDK exposes no such signal
either. Draining would also duplicate history the store already holds.

Consequence: the harness session id is never an addressable identity on the wire. It
is opaque, harness-controlled, and up to 256 characters, so two harnesses can return
the same one. Every wire reference to stored history is a k5-minted `storeId`, and the
browser cannot address a store by anything else.

## The store is the authority at boot

A stored summary that lags its own log is not trusted. The log wins, and the summary is
reconciled from it. This is the same rule the boot path applies to a log that ended
mid-turn: the log is the record, and anything derived from it is a cache.

A log that ends mid-turn is marked as such instead of being reported complete, because
"it stopped cleanly" and "the process was killed" are different facts and only one of
them is knowable after the fact.

## Continuation resumes; discovery lists

Continuing a stored task uses `session/resume`, not `session/load`. `session/load` is
for handing the model a history it has not seen; `session/resume` is for continuing one
it has. Only `resume` is paired with the absence of a replay terminator, because k5
never asks the harness to replay.

`session/list` runs on a short-lived, headless seat, created on demand and torn down
after the read. A listing is a read, so it must not take a live seat slot, must not
create a session, and must not leave a harness process behind. Headless opens are
capped and concurrent, because a user clicking refresh repeatedly is a normal thing to
do and a pile of harnesses is not.

The capability probe is lenient. A harness that advertises nothing usable is reported
as unsupported rather than treated as a failure, because harnesses vary widely in what
they populate and a strict probe would refuse a harness that would have worked.

## `attachSession` is a runtime-checked shim

ACP's `ClientContext` exposes no public `attachSession`, but the method exists at
runtime. Adopting a listed session depends on it, so the call is feature-detected once
and refuses loudly when it is missing, rather than being assumed.

## `turn.started` carries the prompt

The browser already holds the prompt text and shows it optimistically, so the live
reducer ignores `userText`. It is on the event because a reloaded transcript is read
from the store, and a stored session without it shows only the assistant's half of every
exchange.

## Null titles never blank a title

ACP's `session_info_update` treats a null title as "clear the title." k5 does not
honour that. A stored session that loses its name falls back to its opening prompt,
which is more useful than a blank sidebar row, so a null here means "this update
carried no title."

## A transcript that could not be fully read says so

Every read that cannot prove completeness reports it. A transcript is offered as a
prefix with a stated gap rather than as a whole thing, because the failure mode of
silently dropping the middle of a conversation is invisible to the person reading it.

Two consequences in the browser reader, both learned from a transcript that came back
empty with no error anywhere:

- On a cursor the store will not honour, the read restarts from the beginning **once**,
  and the discard of what was already read is **deferred until that restart returns a
  usable page**. Clearing eagerly and then finding the restart also refused the cursor
  erased a full transcript and left nothing to report.
- Rehydrating is bounded, and a rehydrate that never settles or throws synchronously
  cannot strand the socket closed. A workspace with no reconnect is worse than one
  missing a turn.

## Command failures are scoped to what failed

A failed `session.configure`, `session.list`, or `session.load` reports into the
session message and changes nothing else. Treating any of them as a turn failure killed
the working dots and then dropped every remaining delta from a harness that was still
streaming, so a finished answer stayed truncated with an error badge on it.

## A cap is reported, not applied silently

Retained view entries are capped and the oldest are dropped, and the drop is reported
so the UI can say the transcript is a tail. A cap that reports nothing is a lie about
completeness.

The retained cap also bounds the copy cost of the delta append: only the matching entry
is rebuilt, because mapping the whole array on every chunk made a long turn quadratic.

## Stored tasks are addressable by the browser and deletable by the user

The sidebar lists what the store actually holds over HTTP, so a reload shows the history
that is there rather than what one live session happens to be. A live session appears
only until the store catches up with it, so opening a task does not produce a duplicate
row.

Every task that can be opened can also be removed. A store with no delete is a one-way
door, and the browser refreshes from the store's receipt rather than optimistically.

## Store location rules

The store root is `XDG_DATA_HOME/k5-work`, defaulting to `~/.local/share/k5-work`. A
relative `XDG_DATA_HOME` is refused rather than resolved: resolving anchors the store to
`process.cwd()`, which differs under `npm run dev`, systemd, and a process manager, so
one machine would keep three different transcripts. `~` is refused because `path.resolve`
does not expand it and a literal `~` directory would be created instead of reported.

The forbidden-directory check runs on the resolved *base*, not the joined root, because
`resolve(base, "k5-work")` can never equal its own base and a check there could never
fire. `$HOME/.local/share` is deliberately not forbidden: it is the spec's own default,
and refusing it would stop every ordinary boot.

## Test registration is explicit and silent

`shared` and `server` run `node --test` over a hand-listed set of compiled files. A new
test file that is not added to that list does not fail, does not run, and is invisible:
`sessions.test.ts` sat unregistered through several rounds of work, with ten tests that
had never once executed. A suite that cannot fail is not a suite.
