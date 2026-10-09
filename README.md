# WMCoach

Walter's personal coaching app: an offline-first iPhone PWA on GitHub Pages for lifting (Program C), body weight and measurements, and the weekly meal-prep plan.

- **App:** https://woojmcd.github.io/WMCoach/ (open in Safari → Share → Add to Home Screen)
- **Spec:** [`claude/APP_SPEC.md`](claude/APP_SPEC.md) · history and nutrition math: [`claude/AGENT_BRIEF.md`](claude/AGENT_BRIEF.md) · program: [`claude/TRAINING_HISTORY.md`](claude/TRAINING_HISTORY.md)
- **Working on the code:** see [`CLAUDE.md`](CLAUDE.md) (layout, commands, release rules)

```
npm install
npm test          # unit + migration tests
npm run e2e       # headless iPhone-size run with screenshots
npm run serve     # http://localhost:8080/WMCoach/
```
