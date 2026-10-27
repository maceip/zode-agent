# Flow workspace sketches

Flow applies the chat draft's spacing and colors to Alto's workspace tabs, pane headers, conversations, review controls, and answered questions. These sketches retain the Contour composer and explore the surrounding interface; the workspace design is not installed in the live program.

- [Split view, light](split-light.png)
- [Split view, dark](split-dark.png)
- [Focused chat](focused-light.png)
- [Focused chat with sidebar](sidebar-light.png)

`alto-flow.html` is the editable visualization fragment. Open it with the `visualize` skill's renderer, which supplies its icons and optional design controls. The fragment includes its preview images and keeps interactions local: pane focus, sidebar visibility, activity disclosures, image previews, review, and task checkboxes.

The preview was checked at widths from 320 to 1920 pixels in light and dark themes. On narrow screens, panes stack so both conversations remain readable.
