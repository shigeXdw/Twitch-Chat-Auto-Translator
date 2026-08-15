# Twitch Chat Auto Translator

A Tampermonkey userscript that automatically translates Twitch chat into a language you choose. Translations appear directly below the original message with a compact source-country badge. Hover over the badge to see the detected language.

## Install

1. Install the Tampermonkey browser extension.
2. Open Tampermonkey's dashboard and choose **Create a new script**.
3. Replace the sample code with everything in `twct.js`.
4. Save with **Ctrl+S**, then reload Twitch.

The initial target is English. To change it, open the Tampermonkey extension menu while on Twitch and choose **⚙ Translation settings**.

## Notes

- Google Translate works without an API key. DeepL API Free and Pro are also supported with your own key.
- A separate floating Translation Services window lets incoming chat and outgoing messages use different services.
- OpenAI-compatible AI endpoints such as OpenRouter can translate and optionally rewrite tone or style using a custom API key, endpoint, model, instruction, and output-token limit.
- The AI-compatible settings card includes a toggle that overrides the normal outgoing provider without changing incoming chat translation.
- Incoming translations place the detected source-country badge before the translated text.
- DeepL keys are stored locally by Tampermonkey. Because browser userscripts can expose secrets, use a dedicated revocable key.
- Messages already written in the selected language are left alone.
- URLs, emote-only messages, and messages over 450 characters are skipped.
- Twitch occasionally changes its page markup. If translations stop appearing, the selectors near the top of the script may need updating.
- Translation services can rate-limit very busy chats. The script limits simultaneous requests and caches repeated messages.
- Translations preserve Twitch's auto-scroll when chat is already near the bottom. They do not force scrolling while you are reading older messages.
- The settings menu includes configurable requests-per-minute, pending-queue size, and maximum message age limits. Defaults are 15 requests/minute, 50 pending messages, and 30 seconds.
- An optional maximum-viewer setting can restrict translation to smaller chats. Set it to 0 to disable the restriction.
- Newest messages are prioritized. HTTP 429 responses use exponential backoff with jitter; three consecutive rate-limit responses trigger a five-minute cooldown.
- Performance-conscious operation: only the chat message container is observed, background tabs pause DOM work, viewer polling runs only when its limit is enabled, queues are bounded, and the translation cache retains at most 200 entries.
- When outgoing translation is enabled, Enter or Twitch's Send button translates the current draft and then resumes sending. Left-click only translates the draft, middle-click toggles the feature, and right-click opens settings.
- Optional local romaji recognition can identify common romanized Japanese words and grammar, then explicitly translate them from Japanese instead of relying on automatic Latin-script detection.
- A compact translation button is integrated into Twitch's chat composer. Green means enabled and gray means disabled.
