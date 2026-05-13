# Logo

Drop your logo file here as `Logo.png` (capital L).

The site is wired to load `assets/images/Logo.png` automatically — see
`Front-end/shared/logo.js`, which renders this file on the auth page and
inside every role module's header.

**Filename is case-sensitive when served over HTTP**, so `logo.png` and
`Logo.png` are treated as different files in the browser. If you want to
rename, update both the file AND the `src` in `logo.js`.

## If you want to use a different filename or format

Edit one line in `Front-end/shared/logo.js`:

```js
el.innerHTML = '<img src="assets/images/logo.png" alt="Heartworks Learning Center" />';
```

Change the `src` to match your file (e.g. `logo.svg`, `crest.png`, etc.).

## Recommended

- **Format:** SVG if you have one (stays crisp at any size), otherwise PNG
- **Resolution:** 256×256 or 512×512 is plenty — the logo renders small on screen
- **Background:** transparent (the logo sits on a colored card)

## Reverting to the placeholder

If you ever want the placeholder back, flip `USE_PLACEHOLDER` back to
`true` at the top of `Front-end/shared/logo.js`.
