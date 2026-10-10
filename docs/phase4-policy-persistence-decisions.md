# Phase 4: policy and persistence

Durable decisions behind the session store and continuation. Code
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

Both ends of the log are taken from the log itself. `firstSeq` is repaired from the
lowest record on disk, because it is the start of a read: a repair derived from
`lastSeq` turned a session killed during its first turn into one whose transcript was
its final record. `updatedAt` orders the list, because `lastSeq` counts records inside
one session and says nothing about when it was last touched.

## Continuation resumes on a headless seat

Continuing a stored task uses `session/resume`, not `session/load`. `session/load` is
for handing the model a history it has not seen; `session/resume` is for continuing one
it has. Only `resume` is paired with the absence of a replay terminator, because k5
never asks the harness to replay.

A headless seat is short-lived, created on demand and reaped when the read is done, which
for a continuation means the adopted seat is promoted rather than torn down. A read must
not take a live seat slot, must not create a session, and must not leave a harness process
behind. Headless opens are capped and concurrent, because a user opening three tasks in
a row is a normal thing to do and a pile of harnesses is not.

The cap counts resident harness processes, not in-progress opens. It is released when
the child is gone, or when a continuation promotes the seat and the pool starts
counting it under a live seat's own key.

A continued task streams through the connection that asked for it. The seat a
continuation adopts is the one the read opened, so it is created with the same event
forwarder a fresh open gets. A seat with no forwarder still answers a prompt: the
harness produces deltas that reach no viewer and no store, and the only evidence is an
empty bubble.

The capability probe is lenient. A harness that advertises nothing usable is reported
as unsupported rather than treated as a failure, because harnesses vary widely in what
they populate and a strict probe would refuse a harness that would have worked.

## `attachSession` is a runtime-checked shim

ACP's `ClientContext` exposes no public `attachSession`, but the method exists at
runtime. Adopting a harness session depends on it, so the call is feature-detected once
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

- A refused cursor costs the read one restart, and whatever was already read is kept
  until that restart returns a usable page. Clearing eagerly and then finding the
  restart also refused the cursor erased a full transcript and left nothing to report.
- Rehydrating is bounded, and a rehydrate that never settles or throws synchronously
  cannot strand the socket closed. A workspace with no reconnect is worse than one
  missing a turn.

The read runs on the reconnect and on a continuation, because those are the two moments
the store holds history the socket has not delivered. A continuation changes no view
state of its own, so the reader is what puts the opened task's conversation on screen
instead of leaving the previous task's there.

## Command failures are scoped to what failed

A failed `session.configure` or `session.load` reports into the
session message and changes nothing else. Treating either as a turn failure killed
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
row. That row carries a `storeId` like every other, because the browser addresses stored
history by nothing else: a row keyed by the harness's session id sends a `DELETE` for a
task the store has never heard of and asks the server to continue a session it cannot
name.

Every task that can be opened can also be removed. A store with no delete is a one-way
door, and the browser refreshes from the store's receipt rather than optimistically. A
remove that does not happen is reported, and the control is reachable without a pointer,
so a touch device is not left with a task it can open but not delete.

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

## The seat's update stream belongs to the session, not to a turn

`nextUpdate()` reads a queue that belongs to the ACP session, so there is exactly one
pump for the seat's lifetime and it routes to whichever turn is active. A pump per turn
means a cancelled turn's pump is still awaiting when the next turn begins, receives that
turn's opening updates, drops them, and poisons the seat.

Terminal state does not come from the pump's `stop` message. The SDK matches a prompt's
response to that prompt, so `session.prompt()` resolving is the only trustworthy signal. A
`stop` read off the shared queue cannot be attributed: a harness that ignores
`$/cancelRequest` never sends one for the cancelled turn, so the next `stop` on the wire
belongs to the *live* turn. Matching it against a list of abandoned turns swallowed the
live turn's completion instead, which is what the failing test caught.

## A drain bound belongs after the abort, not at the start

`CANCEL_DRAIN_MS` was armed when a turn began, though its own comment said it bounded the
drain for a cancelled or timed-out turn. Any turn slower than five seconds was settled as
`cancelled` with its answer truncated mid-word, and the seat was then poisoned with
"harness did not stop after a cancel", so every later prompt was refused. Real OpenCode
turns measured 4.25s, 6.84s and 16.4s, so most of them were being killed.

This is also why a model provider looked broken for a long stretch of this work. It was
never broken. k5 was cancelling the turns. **When a component disagrees with itself, read
the two claims before believing either:** the comment and the code here contradicted each
other for the whole life of the bug, and the comment was the correct one.

Fixing the timer exposed the pump bug underneath it, which the force-settle had been
hiding. Expect that: a bound that fires early is often the only thing keeping a deeper
defect from being visible.

A cancelled turn keeps a drain window in which the harness's trailing updates are
forgiven rather than treated as misbehaviour. That is what the five seconds was for
originally.

## Attachments reach the model inline, never by reference

A `resource_link` is never emitted. k5 advertises `fs.readTextFile: false`, so a path on
k5's disk is one the harness provably cannot open, and a link renders as a real attachment
while delivering nothing. `resource` is exactly the variant gated on `embeddedContext`, so
that one capability covers every kind and a harness without it refuses the turn outright
rather than accepting one that claims an attachment the model never saw. Real OpenCode
1.18.32 advertises `embeddedContext: true`, so the path is live.

Attachment ids are k5-minted and opaque (`k5-attachment:<id>`). No filesystem path reaches
a block, and a real 1x1 PNG was read back by the model through that scheme.

An image rides as a `resource` block, not an `image` block, so there is one capability gate
rather than two. The wire accepts it; whether the model can see it is a separate fact. The
default model here has no vision and says so in plain words, which is a model capability
and not a protocol failure.

## A per-file cap is not a per-prompt cap

The wire accepted eight attachments of 25 MB each. Nothing was wrong with any one of them,
so nothing objected, and the service read every file into memory before it built a single
block: 200 MB resident at once, and base64 expanding each one by four thirds before the
bytes were serialised, so the real peak was nearer 270 MB. On a machine that also has to hold
a dev server and a harness process, that is the spike that makes the process look like it
leaked.

A second ceiling now applies to one prompt's attachments added together. It is checked from
the manifests, before the first byte is read, because a refusal that has already loaded the
files it is refusing is a refusal that pays the cost it exists to avoid. The prompt is refused
whole rather than trimmed: a turn that silently drops half its attachments is worse than one
the user can retry after attaching less.

The per-file cap stays, because a single large file is a thing a user genuinely wants to
attach and 25 MB is a fair answer to that. It is the *count* of them that needs a bound.

## Spooled bytes are charged, and charged back

The whole-store ceiling was checked against a counter the spool never incremented, so every
upload passed the check however many had gone before and the disk grew without bound.
Spooled bytes are accrued per session and released on discard, on remove, and on eviction.

Charging without discharging is its own bug: a store that once held a large attachment would
refuse real writes for the rest of the process while the disk was wide open. All three
release paths need a test, because the fourth path is the one someone will add.

A partial upload leak is the same class of problem one layer up. Racing three uploads and
refusing the second leaves two spooled, referenced by nothing, with the caller never learning
their ids and no way out except deleting the whole task. The batch is settled rather than
raced, and whatever landed is given back before the failure is reported.

## Bytes are never recorded, only a manifest

A base64 image in the events table would blow the store's 12 MiB per-session cap and render as
a wall of garbage in the user bubble. The transcript records name, mime, size and kind.

## A resolved posture needs a discriminator or it is a lie

When the resolver cannot be read, posture resolution substitutes a placeholder that carries
`wildcardAllow: true`. Without a `verified` flag the browser cannot tell that placeholder
from an observed blanket `*: allow`, and would render a verified claim out of a harness
nobody checked. `verified` is keyed off the resolver having counted at least one rule, which
is sound because the resolver throws on a rule list with no readable allow grant.

It is checked **before** `wildcardAllow`, or the placeholder prints the lie.

The posture is deliberately not persisted. It is a property of the seat, not of the
conversation, so storing it repeats one unchanging value across the whole log and a
rehydrated task would show the permissions of a harness that has since been reaped.

The resolved posture was being discarded inside `SeatRunner.gate`. Putting the contract on
the wire alone would have left the browser permanently unverified while the code looked
complete, so a change that looked like plumbing was load-bearing.

## A skip that excuses a fixed bug lets it survive twice

The real-harness test had grown a branch that skipped when a turn came back `cancelled`,
documenting k5's own five-second drain as though it were the provider's state. It kept the
suite green while the bug was live. It is deleted, and the test now asserts a real terminal
stop.

The general rule: when a test is made lenient to accommodate a defect, the leniency needs
an owner and a removal condition. Otherwise it becomes the contract.

## Test registration is explicit and silent

`shared` and `server` run `node --test` over a hand-listed set of compiled files. A new
test file that is not added to that list does not fail, does not run, and is invisible:
`sessions.test.ts` sat unregistered through several rounds of work, with ten tests that had
never once executed. A suite that cannot fail is not a suite.

The fake harness responds in milliseconds, so no fake-harness suite can prove anything about
a turn that is supposed to take time. A green suite over fakes is not evidence about real
latency, and that gap hid a bug that shipped in this branch.

