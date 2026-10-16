# k5-bot

The language of this app: a person signs in, creates bots, and talks to them.

## Language

**Bot**:
The long-lived thing a user creates: a name, an avatar, and a chosen provider. It keeps going indefinitely.
_Avoid_: agent, character, companion

**Session**:
One durable transcript belonging to a bot, stored so it survives a restart.
_Avoid_: chat, thread

**Provider**:
The harness a bot is set to, picked by the user when the bot is created.
_Avoid_: seat, backend, model
