'use strict';

var obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    openaiApiKey: "",
    model: "gpt-4o-mini"
};
// =============== MAIN PLUGIN CLASS ==================
class ImageToTextPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.settings = DEFAULT_SETTINGS;
    }
    async onload() {
        console.log("✅ ImageToTextPlugin loaded");
        await this.loadSettings();
        this.addSettingTab(new ImageToTextSettingTab(this.app, this));
        // Отслеживаем добавление новых файлов в хранилище
        this.registerEvent(this.app.vault.on("create", async (file) => {
            if (file.extension.match(/(png|jpg|jpeg|webp)/i)) {
                new obsidian.Notice(`🖼 Processing ${file.name}...`);
                await this.processImage(file);
            }
        }));
    }
    onunload() {
        console.log("🛑 ImageToTextPlugin unloaded");
    }
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    // =============== IMAGE PROCESSING ==================
    /**
 * Пытается извлечь JSON из произвольного текста.
 * Поддерживает случаи:
 * - ```json\n{...}\n```
 * - ```\n{...}\n```
 * - текст до/после JSON (берёт первую/последнюю фигурную скобку)
 */
    extractJsonFromText(text) {
        if (!text || typeof text !== "string")
            return null;
        // Убираем BOM и нежелательные невидимые символы
        text = text.replace(/^\uFEFF/, "").trim();
        // 1) Попытка извлечь содержимое между тройными backticks ```...```
        const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
        const fenceMatch = text.match(fenceRegex);
        if (fenceMatch && fenceMatch[1]) {
            return fenceMatch[1].trim();
        }
        // 2) Если нет fence — найти первый { и последний } и вырезать
        const firstBrace = text.indexOf("{");
        const lastBrace = text.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return text.slice(firstBrace, lastBrace + 1).trim();
        }
        // 3) Возможно, ответ уже чистый JSON (без фигурных скобок?) — вернуть оригинал как fallback
        return text.trim() || null;
    }
    /**
     * Попытка безопасно распарсить JSON, с логами для отладки.
     * Возвращает объект или throws ошибку.
     */
    tryParseJson(text) {
        const candidate = this.extractJsonFromText(text);
        if (!candidate)
            throw new Error("No JSON found in response text");
        // Убираем лишние символы в начале/конце (например, кавычки, точки)
        const cleaned = candidate
            .replace(/^\u200B/g, "") // zero-width
            .replace(/\u00A0/g, " ") // non-breaking space
            .trim();
        try {
            return JSON.parse(cleaned);
        }
        catch (err) {
            // Бросаем подробную ошибку, чтобы видно было candidate и исходный текст
            const e = new Error("JSON.parse failed: " + err.message);
            e.candidate = cleaned;
            e.original = text;
            throw e;
        }
    }
    /**
     * Простая санитация имени файла (убирает запрещённые символы)
     */
    sanitizeFileName(name) {
        return name.replace(/[\\/:"*?<>|]+/g, "").trim() || "contact";
    }
    async processImage(file) {
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);
            const base64 = arrayBufferToBase64(arrayBuffer);
            if (!this.settings.openaiApiKey) {
                new obsidian.Notice("⚠️ Please set your OpenAI API key in the plugin settings.");
                return;
            }
            new obsidian.Notice(`📤 Sending ${file.name} to OpenAI...`);
            // Новый формат контента для Vision
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
                                    '  "rawText": ""\n' +
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
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.settings.openaiApiKey}`
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content ?? "{}";
            const parsed = this.tryParseJson(content);
            const name = parsed.name?.trim() || "Unknown Contact";
            const safeName = this.sanitizeFileName(name);
            new obsidian.Notice(`name: ${name}`);
            new obsidian.Notice(`safeName: ${safeName}`);
            //-----------------------------------------------------------
            // 🔍 1. Ищем заметку, которую создал Obsidian при импорте фото
            //-----------------------------------------------------------
            // Ждём, пока Obsidian создаст файл заметки
            await new Promise(res => setTimeout(res, 200));
            const embed = `![[${file.name}]]`;
            let pictureNote = null;
            // Ищем заметку, где содержится embed
            this.app.vault.getMarkdownFiles().forEach(md => {
                console.log(`checking note:`, md);
                if (!pictureNote) {
                    this.app.vault.read(md).then(content => {
                        console.log(`content check: ${content}`);
                        if (content.includes(embed)) {
                            pictureNote = md;
                        }
                    });
                }
            });
            // Ждём завершения поиска
            await new Promise(res => setTimeout(res, 200));
            //-----------------------------------------------------------
            // 📌 2. Если нашли созданную Obsidian заметку — используем её
            //-----------------------------------------------------------
            if (pictureNote) {
                const oldContent = await this.app.vault.read(pictureNote);
                const newContent = `# ${name}\n\n` +
                    embed +
                    `\n\n---\n\n` +
                    `Компания: ${parsed.company || "-"}\n` +
                    `Должность: ${parsed.position || "-"}\n` +
                    `Телефоны:\n${parsed.phones?.length ? parsed.phones.map((p) => `- ${p}`).join("\n") : "-"}\n` +
                    `Email:\n${parsed.emails?.length ? parsed.emails.map((e) => `- ${e}`).join("\n") : "-"}\n` +
                    `Website: ${parsed.website || "-"}\n` +
                    `Адрес: ${parsed.address || "-"}\n\n` +
                    `---\n\nПолный текст визитки:\n${parsed.rawText || ""}`;
                await this.app.vault.modify(pictureNote, newContent);
                new obsidian.Notice(`✅ Contact updated in ${pictureNote.basename}`);
                return;
            }
            //-----------------------------------------------------------
            // ❗ 3. Если заметку НЕ нашли — создаём новую
            //-----------------------------------------------------------
            const folder = file.parent?.path ?? "";
            const notePath = `${folder}/${safeName}.md`;
            const noteContent = 
            //`# ${name}\n\n` +
            //embed +
            //`\n\n---\n\n` +
            `Компания: ${parsed.company || "-"}\n` +
                `Должность: ${parsed.position || "-"}\n` +
                `Телефоны:\n${parsed.phones?.length ? parsed.phones.map((p) => `- ${p}`).join("\n") : "-"}\n` +
                `Email:\n${parsed.emails?.length ? parsed.emails.map((e) => `- ${e}`).join("\n") : "-"}\n` +
                `Website: ${parsed.website || "-"}\n` +
                `Адрес: ${parsed.address || "-"}\n\n` +
                `---\n\nПолный текст визитки:\n${parsed.rawText || ""}\n` +
                embed +
                `\n`;
            await this.app.vault.create(notePath, noteContent);
            new obsidian.Notice(`📄 Created new note: ${safeName}`);
        }
        catch (err) {
            console.error("Error processing image:", err);
            new obsidian.Notice(`❌ Error processing ${file.name}`);
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
        containerEl.createEl("h2", { text: "🧠 Image to Text Plugin Settings" });
        new obsidian.Setting(containerEl)
            .setName("OpenAI API Key")
            .setDesc("Введи свой OpenAI API ключ (начинается с sk-...)")
            .addText((text) => text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value.trim();
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName("Model")
            .setDesc("Модель с поддержкой изображений (например, gpt-4o-mini или gpt-4o).")
            .addText((text) => text
            .setPlaceholder("gpt-4o-mini")
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

module.exports = ImageToTextPlugin;
