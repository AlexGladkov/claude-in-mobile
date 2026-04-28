# Android-Only Commands

Commands exclusive to the Android platform.

---

### analyze-screen

Parse current screen and return categorized interactive elements as structured JSON. Groups elements into buttons, inputs, texts, etc. Useful for automated test flows.

```bash
claude-in-mobile analyze-screen
claude-in-mobile analyze-screen --device emulator-5554
```

**Platforms:** Android only

---

### find-and-tap

Fuzzy-match an element by description and tap it. Uses confidence scoring for inexact matches.

```bash
claude-in-mobile find-and-tap "Submit Order" --min-confidence 50
claude-in-mobile find-and-tap "Cancel" --min-confidence 30
```

| Flag | Description | Default |
|------|-------------|---------|
| `--min-confidence <0-100>` | Minimum match confidence threshold | 30 |

**Platforms:** Android only

---

### screen

Control screen power state (turn display on/off).

```bash
claude-in-mobile screen on
claude-in-mobile screen off
```

**Platforms:** Android only
