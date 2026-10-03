# Twitch Translator · Tampermonkey

Chat-only release 5.3.2. This upload contains only the installation page, its stylesheet and the complete installable userscript. No browser-extension, audio companion, build tools or dependencies are required.

## Publish

Upload these files to GitHub keeping the folder structure. In Settings → Pages, select Deploy from a branch, your branch and `/docs`. Share the HTTPS page URL GitHub provides.

## Install

Install [Tampermonkey](https://www.tampermonkey.net/), visit the published page and click Install chat translator. Confirm installation, then refresh Twitch. Disable older translator copies. The gear beside the chatbox opens settings.

If the installer does not open, create a new script in Tampermonkey, paste the contents of `docs/install/twitch-chat-translator.user.js` and save. The `.user.js` contains the script code; no additional source files are needed to install or run it.

Desktop targets: Firefox, Chrome, Edge, Brave and Opera/GX. Chrome-based browsers may require Allow User Scripts. Safari is unverified; mobile is not supported. Automated UI checks use Chromium fixtures, not live tests in every browser.

Chat text is sent to the selected translation service. Enter API keys in settings, never in uploaded files. AI and DeepL may incur charges. Google's no-key endpoint is unofficial. Installation always requires user confirmation.
