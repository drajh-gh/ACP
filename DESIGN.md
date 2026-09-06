---
name: ACP Operations
description: Airport operating board and review desk for consequential project decisions.
colors:
  ink: "#101d2c"
  panel: "#1a2e43"
  white: "#eff4f8"
  amber: "#f3c65c"
  teal: "#7ad6bc"
  red: "#ff9a91"
  muted: "#afbed0"
  line: "#395069"
  nav: "#0d1825"
  hover: "#243d55"
  field: "#142538"
typography:
  display:
    fontFamily: 'Bahnschrift, "Arial Narrow", sans-serif'
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: '"Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  mono:
    fontFamily: '"Cascadia Mono", Consolas, monospace'
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  badge: "3px"
  control: "4px"
  container: "6px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "24px"
  space-6: "32px"
---

# Design System: ACP Operations

## Overview

**Creative North Star: "Airport operating board and review desk"**

ACP uses aligned request rows, named checkpoints and a quiet adjacent review workspace to support careful decisions. Restrained operational signals establish hierarchy while literal labels explain the action and its limits.

This records the isolated HTML/CSS/JavaScript prototype in `prototypes/operations/`. It is a prototype-recorded candidate awaiting David's usability acceptance. All records and transitions are synthetic; this document does not establish the production interface or live integration behavior.

**Key Characteristics:**

- Dense comparison beside readable decision context.
- Navy surfaces with restrained amber, teal and red signals.
- Literal actions, visible uncertainty and explicit sample provenance.

## Colors

The six supplied colors establish the identity; five implemented support colors separate navigation, fields, text, dividers and hover states.

Attention amber is the primary emphasis for decisions, selected filters and keyboard focus. Operations ink supplies dark text on bright action surfaces. Verified teal identifies established sample results. Exception red identifies unknown or unconfirmed outcomes requiring reconciliation; it does not mean every waiting state failed.

Instrument white carries primary reading. Muted text supports metadata and explanations. Console panel contains the review desk and selected rows; navigation and field tones distinguish subordinate surfaces. The line tone separates rows and sections.

**The Explicit State Rule.** Status text carries the meaning; color reinforces it.

## Typography

Bahnschrift supplies short operational headings. Segoe UI carries reading and controls. Cascadia Mono aligns identifiers and ages with tabular numerals. These are the supplied prototype font choices, with the recorded fallbacks.

The page heading uses the display token and reduces to 28px on small screens. Review titles use 22px; the dialog heading uses 21px. Section titles use 14px semibold, with a 16px board section heading. Review prose uses 13px with a 1.7 line height; metadata generally uses 11–12px. Paragraphs have a 70ch maximum.

Short table headings use uppercase and modest tracking. Sentences and action labels remain in sentence case.

## Layout

The wide shell combines a 184px navigation rail with a flexible main area. Its board and review desk use a 24px gap; the desk occupies 400–520px. Between 1051px and 1300px, the rail narrows to 152px and the desk to 365–440px.

At 1050px and below, selecting a request replaces the board with the review workspace. Review content and actions flow with the page. Returning restores the board position and request focus.

At 640px and below, navigation becomes horizontal, main padding narrows to 16px, and the age column leaves the board. The detail header retains checkpoint, next owner and sample age. Action buttons wrap in normal flow. The journey strip retains three columns.

The reusable spacing vocabulary supports compact control groups and larger separations between reading sections; it is not a universal grid requirement.

## Elevation & Depth

Depth comes from navy tonal separation and one-pixel borders. There are no elevation shadows or gradients. The small amber box-shadow on selected filters and review tabs is an underline, not a lifted surface. The readiness dialog uses a dark translucent backdrop.

## Shapes

Controls and contained scope text use modest corners. Badges are slightly tighter; the review desk and dialog use the container radius. Board rows and journey cells remain rectangular and aligned. Outline SVGs communicate functional shapes without external image assets.

## Components

Buttons use a 40px minimum height, compact padding and a one-pixel border. Primary actions use amber with ink text; secondary actions use transparent backgrounds. Hover and pressed fills are explicit. Disabled controls use muted text and the field tone. Keyboard focus uses an amber 2px outline with a 3px offset.

Fields use dark filled surfaces, a visible border and amber caret. Scope, rejection and evidence editors appear inline; opening an editor reveals and focuses it. Save or cancel resolves the edit before switching the request or view.

Navigation uses a panel fill and amber text for its current item. Board filters use an amber underline and explicit pressed state. Review tabs use the same underline with white selected text and support arrow, Home and End navigation.

Status badges use restrained outlines and explicit labels. Decision and incomplete states use amber, passed states teal, and unknown outcomes red. Neutral states retain muted text.

The review desk keeps request metadata, decision context, evidence tabs and exact action limits together. Its wide layout scrolls the reading area while retaining the surrounding controls. Narrow layouts place the complete review and actions in normal page flow.

The selected journey repeats named checkpoints from the request. Passed, current and pending states remain distinct, and the current checkpoint follows the selected record. Its key states that a checkpoint is not the final outcome.

Interactions use a short background-color transition. Reduced motion removes transitions. Rendering preserves review scroll and focus where applicable; active edits prevent view changes that would discard their content.

## Do's and Don'ts

### Do

- Do pair every status color with explicit text.
- Do keep checkpoint, final outcome and next owner distinguishable.
- Do retain action scope, recipients where relevant, and verification limits in the review.
- Do identify authored sample data and simulated actions visibly.
- Do preserve visible keyboard focus and readable narrow-screen review context.

### Don't

- Don't depict a click as proof of execution or verification.
- Don't introduce decorative gradients, imagery or ambient motion into this working console.
- Don't invent flight times, airport codes or operational progress.
- Don't treat prototype measurements or styling as David's usability acceptance.
