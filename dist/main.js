'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    openaiApiKey: "",
    model: "gpt-4o-mini"
};
// ==================== MODAL =============================
class ConfirmImageProcessModal extends obsidian.Modal {
    constructor(app, file, onConfirm) {
        super(app);
        this.file = file;
        this.onConfirm = onConfirm;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Recognize business card?" });
        contentEl.createEl("p", {
            text: `Do you want to send "${this.file.name}" to OpenAI for recognition?`
        });
        const btnRow = contentEl.createDiv({ cls: "modal-button-row" });
        const recognizeBtn = btnRow.createEl("button", {
            text: "Recognize",
            cls: "mod-cta"
        });
        const cancelBtn = btnRow.createEl("button", {
            text: "Cancel"
        });
        recognizeBtn.onclick = () => {
            this.close();
            this.onConfirm();
        };
        cancelBtn.onclick = () => {
            this.close();
        };
    }
    onClose() {
        this.contentEl.empty();
    }
}
// =============== MAIN PLUGIN CLASS ==================
class ImageToTextPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.settings = DEFAULT_SETTINGS;
    }
    async onload() {
        console.debug("✅ ImageToTextPlugin loaded");
        await this.loadSettings();
        this.addSettingTab(new ImageToTextSettingTab(this.app, this));
        // We monitor the addition of new files to the repository
        this.registerEvent(this.app.vault.on("create", async (file) => {
            if (file.extension.match(/(png|jpg|jpeg|webp)/i)) {
                new obsidian.Notice(`🖼 Processing ${file.name}...`);
                // We'll wait a bit for Obsidian to create a note
                await new Promise(resolve => setTimeout(resolve, 1000));
                // await this.processImage(file);
                new ConfirmImageProcessModal(this.app, file, () => {
                    void this.processImage(file);
                }).open();
            }
        }));
    }
    onunload() {
        console.debug("🛑 ImageToTextPlugin unloaded");
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    // =============== IMAGE PROCESSING ==================
    extractJsonFromText(text) {
        if (!text || typeof text !== "string")
            return null;
        text = text.replace(/^\uFEFF/, "").trim();
        const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
        const fenceMatch = text.match(fenceRegex);
        if (fenceMatch && fenceMatch[1]) {
            return fenceMatch[1].trim();
        }
        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return text.slice(firstBrace, lastBrace + 1).trim();
        }
        return text.trim() || null;
    }
    tryParseJson(text) {
        const candidate = this.extractJsonFromText(text);
        if (!candidate)
            throw new Error("No JSON found in response text");
        const cleaned = candidate
            .replace(/^\u200B/g, "")
            .replace(/\u00A0/g, " ")
            .trim();
        try {
            return JSON.parse(cleaned);
        }
        catch (err) {
            const e = new Error("JSON.parse failed: " + err.message);
            throw e;
        }
    }
    sanitizeFileName(name) {
        return name.replace(/[\\/:"*?<>|]+/g, "").trim() || "contact";
    }
    async findNoteWithImage(imageFile) {
        const embed = `![[${imageFile.name}]]`;
        const markdownFiles = this.app.vault.getMarkdownFiles();
        console.debug(`markdownFiles:`, markdownFiles);
        for (const mdFile of markdownFiles) {
            console.debug(`check md:`, mdFile.name);
            try {
                const content = await this.app.vault.read(mdFile);
                if (content.includes(embed)) {
                    console.debug(`✅ Found note with image: ${mdFile.name}`);
                    return mdFile;
                }
            }
            catch (error) {
                console.error(`Error reading ${mdFile.name}:`, error);
            }
        }
        console.debug(`❌ No note found with embed: ${embed}`);
        return null;
    }
    // Adding a method to determine the MIME type
    getMimeType(file) {
        const ext = file.extension.toLowerCase();
        switch (ext) {
            case 'jpg':
            case 'jpeg':
                return 'image/jpeg';
            case 'png':
                return 'image/png';
            case 'gif':
                return 'image/gif';
            case 'webp':
                return 'image/webp';
            case 'bmp':
                return 'image/bmp';
            default:
                return 'image/jpeg';
        }
    }
    async processImage(file) {
        try {
            const originalBuffer = await this.app.vault.readBinary(file);
            const mimeType = this.getMimeType(file);
            const { rotation, buffer } = await detectBestRotation(originalBuffer, mimeType, this.settings.openaiApiKey);
            new obsidian.Notice(`🧭 Image rotation detected: ${rotation}°`);
            const base64 = arrayBufferToBase64(buffer);
            // create data URL
            const dataUrl = `data:${mimeType};base64,${base64}`;
            // Paste as base64 into Markdown
            const imageEmbed = `![${file.basename}](${dataUrl})`;
            if (!this.settings.openaiApiKey) {
                new obsidian.Notice("Please set your OpenAI API Key");
                return;
            }
            new obsidian.Notice(`📤 Sending ${file.name} to OpenAI...`);
            // Send image to OpenAI
            const payload = {
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "Распознай текст визитки и верни строго JSON формата:\n\n" +
                                    "{\n" +
                                    '  "name": "",\n' +
                                    '  "company": "",\n' +
                                    '  "position": "",\n' +
                                    '  "phones": [],\n' +
                                    '  "emails": [],\n' +
                                    '  "website": "",\n' +
                                    '  "address": "",\n' +
                                    '  "rawText": "",\n' +
                                    "}\n\n" +
                                    "Заполни максимально точно по содержимому визитки."
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64}`
                                }
                            }
                        ]
                    }
                ]
            };
            // use requestUrl from obsidian API instead of fetch
            const response = await obsidian.requestUrl({
                url: "https://api.openai.com/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.settings.openaiApiKey}`
                },
                body: JSON.stringify(payload)
            });
            if (response.status !== 200) {
                throw new Error(`OpenAI API error: ${response.status} ${response.text}`);
            }
            const data = response.json;
            //
            const content = data?.choices?.[0]?.message?.content ?? "{}";
            const parsed = this.tryParseJson(content);
            const name = parsed.name?.trim() || file.basename || "Unknown Contact";
            const safeName = this.sanitizeFileName(name);
            const imgName = safeName + "." + file.extension;
            new obsidian.Notice(`✅ Recognized: ${name}`);
            // Search for an existing note with this image
            // const existingNote = await this.findNoteWithImage(file);
            // rename image file
            await this.app.vault.rename(file, imgName);
            let notePath;
            let noteContent;
            // form the content of the note
            noteContent =
                `**Компания:** ${parsed.company || "-"}\n` +
                    `**Должность:** ${parsed.position || "-"}\n` +
                    `**Телефоны:**\n${parsed.phones?.length ? parsed.phones.map((p) => `- ${p}`).join("\n") : "-"}\n` +
                    `**Email:**\n${parsed.emails?.length ? parsed.emails.map((e) => `- ${e}`).join("\n") : "-"}\n` +
                    `**Website:** ${parsed.website || "-"}\n` +
                    `**Адрес:** ${parsed.address || "-"}\n\n` +
                    `---\n\n` +
                    `**Полный текст визитки:**\n${parsed.rawText || ""}\n` +
                    imageEmbed;
            // create a new image in the note
            const folder = file.parent?.path ?? "";
            notePath = `${folder}/${safeName}.md`;
            // check if file exists
            const existingFile = this.app.vault.getAbstractFileByPath(notePath);
            if (existingFile instanceof obsidian.TFile) {
                // if file exists, add a counter
                let counter = 1;
                let newPath = notePath;
                while (this.app.vault.getAbstractFileByPath(newPath)) {
                    newPath = `${folder}/${safeName} (${counter}).md`;
                    counter++;
                }
                notePath = newPath;
            }
            await this.app.vault.create(notePath, noteContent);
            new obsidian.Notice(`📄 Created new note: ${safeName}`);
            // delete image
            // await this.app.vault.delete(file);
            await this.app.fileManager.trashFile(file);
        }
        catch (err) {
            console.error("Error processing image:", err);
            new obsidian.Notice(`❌ Error processing ${file.name}: ${err.message}`);
        }
    }
} // class ImageToTextPlugin
// =============== SETTINGS TAB ==================
class ImageToTextSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new obsidian.Setting(containerEl)
            .setName("Image to text plugin")
            .setHeading();
        new obsidian.Setting(containerEl)
            .setName("OpenAI API Key")
            .setDesc("The token generated in your OpenAI account")
            .addText((text) => text
            .setPlaceholder("Sk-...")
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value.trim();
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName("Model")
            .setDesc("Gpt-4o-mini or gpt-4o")
            .addText((text) => text
            .setPlaceholder("Gpt-4o-mini")
            .setValue(this.plugin.settings.model)
            .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
        }));
    }
}
// =============== UTILS ==================
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
}
// Поворот изображения на заданный угол
async function rotateArrayBuffer(buffer, degrees, mimeType) {
    const blob = new Blob([buffer], { type: mimeType });
    const img = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Failed to get 2D canvas context.");
    }
    if (degrees === 90 || degrees === 270) {
        canvas.width = img.height;
        canvas.height = img.width;
    }
    else {
        canvas.width = img.width;
        canvas.height = img.height;
    }
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (!b) {
                reject(new Error("Failed to create blob from canvas."));
                return;
            }
            b.arrayBuffer().then(resolve).catch(reject);
        }, mimeType, 0.95);
    });
}
// Оценка читаемости (мини-запрос)
async function scoreImageReadability(base64, apiKey) {
    const payload = {
        model: "gpt-4o-mini",
        max_tokens: 10,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Оцени, насколько удобно читать текст на изображении " +
                            "в текущей ориентации.\n" +
                            "Ответь строго одним числом от 0 до 10."
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/jpeg;base64,${base64}`
                        }
                    }
                ]
            }
        ]
    };
    // const response = await fetch("https://api.openai.com/v1/chat/completions", {
    // 	method: "POST",
    // 	headers: {
    // 		"Content-Type": "application/json",
    // 		"Authorization": `Bearer ${apiKey}`
    // 	},
    // 	body: JSON.stringify(payload)
    // });
    // const data = await response.json();
    // use requestUrl from obsidian API instead of fetch
    const response = await obsidian.requestUrl({
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
    });
    if (response.status !== 200) {
        throw new Error(`OpenAI API error: ${response.status} ${response.text}`);
    }
    const data = response.json;
    ///
    const text = data?.choices?.[0]?.message?.content ?? "0";
    const score = parseInt(text, 10);
    return Number.isFinite(score) ? score : 0;
}
// searching of a best rotation angle
async function detectBestRotation(buffer, mimeType, apiKey) {
    const rotations = [0, 90, 180, 270];
    let bestScore = -1;
    let bestRotation = 0;
    let bestBuffer = buffer;
    for (const deg of rotations) {
        const rotatedBuffer = deg === 0 ? buffer : await rotateArrayBuffer(buffer, deg, mimeType);
        const base64 = arrayBufferToBase64(rotatedBuffer);
        const score = await scoreImageReadability(base64, apiKey);
        console.debug(`[ROTATION CHECK] ${deg}° → score ${score}`);
        if (score > bestScore) {
            bestScore = score;
            bestRotation = deg;
            bestBuffer = rotatedBuffer;
        }
    }
    return { rotation: bestRotation, buffer: bestBuffer };
}

module.exports = ImageToTextPlugin;
