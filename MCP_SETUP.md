# Frost Sampler MCP — connect Claude, ChatGPT and Grok

One secret key protects everything: the MCP that assistants use, and the phone's Cloud sync.

## 1. Create the key (once)
Lovable → Frost Sampler → **Cloud → Secrets → Add secret**
- Name: `FROST_MCP_KEY`
- Value: a long random password (24+ characters; iPhone Passwords can generate one). Keep it in your password manager.

Never paste the key into a chat with an AI; only into the connector settings below and the app.

## 2. Turn on sync on your phone
Frost Sampler → tap the project name → **Cloud sync** → paste the key → **Save**. It should read "On — synced with the cloud".
Your projects (and imported recordings) upload; from now on edits flow both ways.

## 3. Connect the assistants
MCP URL (with key — for apps that only take a URL):

    https://frost-sampler.lovable.app/mcp?key=YOUR_KEY

| Assistant | Where |
|---|---|
| **Claude** (claude.ai / app) | Settings → Connectors → Add custom connector → paste the URL above. |
| **Claude Code** | `claude mcp add --transport http frost https://frost-sampler.lovable.app/mcp --header "Authorization: Bearer YOUR_KEY"` |
| **ChatGPT** | Settings → Apps & Connectors → Advanced → Developer mode on → Create → MCP server URL = the URL above, Authentication = none (the key is in the URL). |
| **Grok** (xAI API remote MCP) | `server_url`: `https://frost-sampler.lovable.app/mcp`, header `Authorization: Bearer YOUR_KEY` (or use the URL with `?key=`). |

Check: ask the assistant "list my Frost projects". Without/with a wrong key the server answers 401.

## Tools
list_projects · get_project · create_project · delete_project · update_project (name, BPM, quantize, swing) ·
add_audio_from_url · find_chops (hits/equal/beats; hit detection needs WAV) · suggest_tempo (WAV) · make_chops ·
set_chop_markers · set_beat_markers · set_pad (fit stretch/repitch + length, volume, pan, pitch, velocity, plays,
choke, reverse, fades, rename, empty) · list_drum_kits · add_kit_drum · add_pattern · edit_pattern ·
delete_pattern · add_hits · remove_hits · set_lane (mute/solo) · set_song · set_export

Not available through MCP (they need the phone's audio engine): playing audio, rendering WAVs, the device check, AI chops.

## If the key leaks
Change `FROST_MCP_KEY` in Lovable Cloud → Secrets, then update it in the app and each connector. The old key stops working immediately.
