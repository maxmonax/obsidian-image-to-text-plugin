# Business Card AI
An Obsidian plugin that recognizes business cards using AI and creates structured contact notes automatically.
The plugin extracts contact information from a photo of a business card and generates a formatted note with the recognized data and the embedded image.

---

## Features

- AI-powered business card text recognition
- Automatic contact note creation
- Contact name used as note title
- Business card image embedded into the note
- Basic image auto-rotation
- Works on desktop and iOS

---

## How It Works

1. Add or scan a business card image into your Obsidian vault
2. The plugin sends the image to the OpenAI API for recognition
3. A new note is created with structured contact information
4. The business card image is embedded into the note

---

## Installation

### From Obsidian Community Plugins
Once published, the plugin can be installed directly from Obsidian Community Plugins.

### Manual Installation (iOS or testing)

Due to iOS filesystem restrictions, the `.obsidian` folder is hidden by default and cannot be accessed directly.

To manually install the plugin on iOS:

1. Install any Community Plugin from Obsidian (this is required to reveal the plugins folder)
2. After installation, Obsidian will show a popup with the plugin installation path — remember the plugin name
3. Open the Files app and use search to find that plugin folder
4. Navigate one level up to reach:
.obsidian/plugins/
5. Create a new folder named:
business-card-ai
6. Copy `main.js` and `manifest.json` into this folder
7. Restart Obsidian and enable the plugin in Settings → Community Plugins

This limitation is imposed by iOS and is not specific to this plugin.

---

## Configuration

This plugin requires an OpenAI API key.

1. Open Obsidian Settings
2. Go to the plugin settings
3. Enter your OpenAI API key

---

## Privacy & Data Usage

- Images are sent to the OpenAI API **only** for text recognition
- No data is stored, logged, or shared by the plugin
- All processing results are saved locally in your Obsidian vault
- The user is fully responsible for the provided API key

---

## Limitations

- Image rotation may not always be detected correctly
- Recognition quality depends on image quality
- Designed primarily for business cards

---

## Roadmap

- Manual image rotation controls
- Editable recognition preview before note creation
- Improved rotation detection
- Contact export support

---

## License

MIT
