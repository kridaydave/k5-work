# k5-work UI spec (web app, glass over black, no blue-black-gray slop)

## What this is
k5-work is an open-source Cowork-style web app. One command bar where you say "do anything", plus harness seats for OpenCode, Kilo Code, Cline, plus workspace for files, office previews, browser view, plus connectors for Slack, Notion, Linear, Jira. Computer use is off in v1 for potato laptops, shown as disabled slot, not fake. Target user is a knowledge worker on a weak laptop who wants finished deliverables, not terminal wrestling. Also their team admin who wants to see what is connected and what it touched.

## Audience and scene
Primary on a 13-15 inch laptop in browser, 1440x900 baseline, must stay usable at 1280x720. Secondary is a teammate glancing over shoulder. Mood is calm, warm, capable. Not gamer neon, not corporate SaaS gray. Think evening desk lamp, not server room. Glass panels float over a dark photographic background the user supplies. Text must stay readable over photo, so scrims and contrast are load-bearing, not decoration.

## Core content blocks (same in all three directions)
1. Collapsible sidebar: icon rail by default, one icon morphs to "<" on hover, click expands to full panel. Holds sessions/projects, harness picker (OpenCode/KiloCode/Cline), connectors status, computer-use disabled slot.
2. Center command bar: "Do anything..." input, attach button, context folder picker, harness badge, send arrow. Below it an activity stream of approval cards and result cards.
3. Workspace panel: tabs for Files, Preview (docx/xlsx/pptx), Browser (built-in via MCP), with lazy loading so idle cost is near zero.
4. Status line: model name plus context usage plus branch or project name, quiet and small.
5. Background layer: user-supplied photographic images mixed with black, warm and textured, never flat blue-black-gray gradient. Glass panels use real backdrop blur with flat fallback for weak GPUs.

## Tone and feel keywords
Warm, quiet, tactile, honest. Glass that feels like frosted paper, not neon ice. Accent colors drawn from background photos (amber, clay, moss, parchment), only one accent per direction. No purple gradients, no cyan glow on #0D1117, no emoji icons, no left-border rainbow cards, no Inter-as-display laziness. Display in a serif or distinctive grotesk, body in system.

## Output format and size
Three standalone HTML files, desktop web app mockup, viewport 1440x900 screenshots. Single file each, inline CSS/JS, no build step, double-click to open. Interactive: sidebar expands/collapses, tabs switch, command bar accepts typing (fake send adds a card), one approval card has working Allow/Deny. No backend, all state in page JS.

## Constraints
- No blue-black-gray AI slop combo. Ban uniform #0D1117 plus cyan/purple glow. Dark is allowed only with warm photographic base and authored light.
- Sidebar behavior is fixed across all three: rail of icons, hover morphs trigger icon to "<", click expands to 240px panel, click again collapses. Must animate width, not just snap.
- Glass must have fallback: @supports backdrop-filter, else solid warm charcoal.
- Readability floor: body 14px min, labels 12px min, contrast 4.5:1 over scrim. First screen must have a clear visual anchor, not empty haze.
- Layout skeletons must differ across directions: direction A centered command island, direction B left-anchored II column with docked input, direction C top bar plus floating cards. Do not ship three reskins of same skeleton.
- Honest placeholders only: if office preview has no real file, show labeled empty state with file name, not fake lorem deck.
- Performance honesty: note GPU-heavy bits in code comments with fallback class names.

## Image needs
Backgrounds are content, not decor. Need 2-3 warm dark photographic textures: e.g. ember paper grain, olive night foliage, terracotta plaster. User said they can install images; until they land, fetch warm Unsplash/Pexels dark textures (no blue neon city, no gray gradient). Base64 inline if small, else local relative path with clear ASSETS comment. Test: remove the photo, does the page feel bland? If yes, the photo is doing its job, keep it.

## Visual motif hypothesis
Each direction picks its motif from office-work metaphors, not tech cliches. A: desk at dusk (horizontal lamplight band). B: index cards and binder tabs (workspace as stacked cards). C: studio wall (pinned sheets, one warm pin accent). Motif must show in composition, not just color.

## Assumptions
- User will drop 1-3 personal BG jpgs into design-demos/assets, we swap them in after selection without redesign.
- Harness names and connector names are final for v1. Model names are placeholders.
- No mobile layout in this round, desktop only.
