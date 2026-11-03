# Abdulrahman Saad Motion

**A free, open-source After Effects panel that brings Claude inside After Effects.**
Describe what you want in plain words (Arabic or English) and Claude builds the animation, automates the work and checks the result, right inside your project.

Built for the Arabic motion design community.

[العربية ↓](#بالعربي)

---

## What it does

- **Chat with Claude inside AE.** It runs Claude Code headless (`claude -p`) on *your own* Claude login. No API key needed.
- **Acts on your project** through a small local MCP server (`127.0.0.1` + a random token per session) with six tools:
  - `run_extendscript`: runs ExtendScript in AE as one undo group
  - `snapshot_frame`: grabs a frame so Claude can see the result
  - `preview_sheet`: many frames on one contact sheet, so Claude can see the motion
  - `read_animation`: learns an animation from the selected layers
  - `save_to_skill`: saves what you teach it into your own skill
  - `listen_timeline`: transcribes the comp's speech to words with frame timings (Whisper, runs locally) for captions
- **Reference images.** Add them with a button, Ctrl/Cmd+V or drag and drop.
- **Your own skills.** Teach it your style and it keeps a skill in your working folder. You can import or export skills as `.zip` to share with others.
- **macOS and Windows.**

## Requirements

- After Effects 2021 (18.0) or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installed, and a Claude account
- On first run of `listen_timeline`, Whisper is downloaded to your computer

## Install

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it.
2. Copy the folder `com.abdulrahmansaad.motion` to:
   - **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/`
   - **Windows:** `%APPDATA%\Adobe\CEP\extensions\`
3. The panel is not signed yet, so enable unsigned extensions once:
   - **macOS** (Terminal): `defaults write com.adobe.CSXS.11 PlayerDebugMode 1`
   - **Windows** (Command Prompt): `reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f`
   (If your AE version uses a different CSXS number, repeat with 9, 10 or 12.)
4. Restart After Effects → **Window → Extensions → Abdulrahman Saad Motion**.
5. Click ⚙ → **Sign in** and approve with your Claude account.

## Privacy

- Everything runs on your computer through your own Claude login.
- The local server only listens on `127.0.0.1` with a random token.
- Claude can only write inside the working folder you choose.

## Contributing

Bug reports, ideas and pull requests are welcome. Open an issue and describe what happened, your AE version and your OS.

## License

[MIT](LICENSE) © Abdulrahman Saad

---

<div dir="rtl">

## بالعربي

**بانل مجاني ومفتوح المصدر بيدخّل Claude جوه أفتر إفكت.**
اكتب اللي عايزه بكلامك، عربي أو إنجليزي، وClaude هيبني الأنيميشن ويعمل الشغل المتكرر ويراجع النتيجة جوه البروجكت بتاعك.

معمول لمجتمع الموشن ديزاين العربي.

### بيعمل إيه

- **شات مع Claude جوه أفتر إفكت** بحساب Claude بتاعك، ومن غير API key.
- **بيشتغل على البروجكت مباشرةً**: بيكتب سكربتات، ويشوف الفريمات، ويقرا الأنيميشن من اللايرز اللي انت مختارها.
- **بيسمع الكلام اللي في الكومب** ويحوّله لكلمات بتوقيتها عشان الكابشن (Whisper على جهازك).
- **صور مرجعية**: من زرار، أو لصق، أو سحب وإفلات.
- **سكيلز خاصة بيك**: علّمه ستايلك، وصدّر السكيل `.zip` وشاركها مع غيرك.
- شغال على **ماك وويندوز**.

### التثبيت

1. نزّل الـ repo (زرار **Code** الأخضر ← **Download ZIP**) وفُك الضغط.
2. انسخ فولدر `com.abdulrahmansaad.motion` لـ:
   - **ماك:** `~/Library/Application Support/Adobe/CEP/extensions/`
   - **ويندوز:** `%APPDATA%\Adobe\CEP\extensions\`
3. فعّل الإضافات غير الموقّعة مرة واحدة (الأوامر في الجزء الإنجليزي فوق).
4. افتح أفتر إفكت ← **Window ← Extensions ← Abdulrahman Saad Motion**.
5. دوس ⚙ ← **تسجيل الدخول** ووافق بحساب Claude بتاعك.

### المتطلبات

- أفتر إفكت 2021 أو أحدث
- Claude Code متسطّب، وحساب Claude

</div>
