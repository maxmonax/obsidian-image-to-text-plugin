import { App, Plugin, PluginSettingTab, Setting, TFile, Notice } from "obsidian";

// =============== SETTINGS ==================

interface ImageToTextSettings {
	openaiApiKey: string;
	model: string;
}

const DEFAULT_SETTINGS: ImageToTextSettings = {
	openaiApiKey: "",
	model: "gpt-4o-mini"
};

// =============== MAIN PLUGIN CLASS ==================

export default class ImageToTextPlugin extends Plugin {
	settings: ImageToTextSettings = DEFAULT_SETTINGS;

	async onload() {
		console.log("✅ ImageToTextPlugin loaded");

		await this.loadSettings();
		this.addSettingTab(new ImageToTextSettingTab(this.app, this));

		// Отслеживаем добавление новых файлов в хранилище
		this.registerEvent(
			this.app.vault.on("create", async (file: TFile) => {
				if (file.extension.match(/(png|jpg|jpeg|webp)/i)) {
					new Notice(`🖼 Processing ${file.name}...`);
					await this.processImage(file);
				}
			})
		);
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
	extractJsonFromText(text: string): string | null {
		if (!text || typeof text !== "string") return null;

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
	tryParseJson(text: string): any {
		const candidate = this.extractJsonFromText(text);
		if (!candidate) throw new Error("No JSON found in response text");

		// Убираем лишние символы в начале/конце (например, кавычки, точки)
		const cleaned = candidate
			.replace(/^\u200B/g, "") // zero-width
			.replace(/\u00A0/g, " ") // non-breaking space
			.trim();

		try {
			return JSON.parse(cleaned);
		} catch (err) {
			// Бросаем подробную ошибку, чтобы видно было candidate и исходный текст
			const e: any = new Error("JSON.parse failed: " + (err as Error).message);
			e.candidate = cleaned;
			e.original = text;
			throw e;
		}
	}

	/**
	 * Простая санитация имени файла (убирает запрещённые символы)
	 */
	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:"*?<>|]+/g, "").trim() || "contact";
	}

	async processImage(file: TFile) {
		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			const base64 = arrayBufferToBase64(arrayBuffer);

			if (!this.settings.openaiApiKey) {
				new Notice("⚠️ Please set your OpenAI API key in the plugin settings.");
				return;
			}

			new Notice(`📤 Sending ${file.name} to OpenAI...`);

			// Новый формат контента для Vision
			const payload = {
				model: "gpt-4o-mini",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text:
									"Распознай текст визитки и верни строго JSON формата:\n\n" +
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

			if (!response.ok) {
				const errText = await response.text();
				console.error("OpenAI API Error:", response.status, errText);
				new Notice(`❌ OpenAI API error ${response.status}: ${errText.slice(0, 120)}...`);
				return;
			}

			const data = await response.json();
			const content = data?.choices?.[0]?.message?.content ?? "{}";

			let parsed;
			try {
				parsed = this.tryParseJson(content);
			} catch (parseErr) {
				// Дополнительный лог в консоль для дебага
				console.error("Failed to parse contact JSON:", parseErr);
				// Если парсить не получилось — сохраняем исходный ответ в отдельную заметку для отладки
				const debugName = `${file.parent?.path ?? ""}/__debug_${file.name}.txt`;
				const debugContent = `=== RAW OPENAI RESPONSE ===\n\n${content}\n\n=== EXTRACT ATTEMPT ===\n\nCandidate:\n${(parseErr as any).candidate ?? "N/A"}\n\nError:\n${(parseErr as Error).message}`;
				try {
					await this.app.vault.create(debugName, debugContent);
					new Notice("❗ Failed to parse JSON. Saved raw response to debug note.");
				} catch (e) {
					console.error("Failed to write debug note:", e);
					new Notice("❗ Failed to parse JSON and couldn't save debug note. See console.");
				}
				return;
			}

			// Теперь у нас parsed — объект
			const name = (parsed.name && String(parsed.name).trim()) || "Unknown Contact";

			// Сохраняем заметку рядом с файлом
			const safeName = this.sanitizeFileName(name);
			const folder = file.parent?.path ?? "";
			const notePath = `${folder}/${safeName}.md`;

			// Вставляем изображение как вложение Obsidian
			const imageEmbed = `![[${file.name}]]`;

			// Создаём текст заметки
			const noteContent = `
Компания: ${parsed.company || "-"}
Должность: ${parsed.position || "-"}
Телефоны: ${parsed.phones?.length ? parsed.phones.map((p: string) => `- ${p}`).join("\n") : "-"}
Email: ${parsed.emails?.length ? parsed.emails.map((e: string) => `- ${e}`).join("\n") : "-"}
Website: ${parsed.website || "-"}
Адрес: ${parsed.address || "-"}

---

Полный текст визитки:
${parsed.rawText || ""}
${imageEmbed}
`;

			await this.app.vault.create(notePath, noteContent);
			new Notice(`✅ Contact saved: ${name}`);

		} catch (err) {
			console.error("Error processing image:", err);
			new Notice(`❌ Error processing ${file.name}`);
		}
	}


} // class ImageToTextPlugin

// =============== SETTINGS TAB ==================

class ImageToTextSettingTab extends PluginSettingTab {
	plugin: ImageToTextPlugin;

	constructor(app: App, plugin: ImageToTextPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "🧠 Image to Text Plugin Settings" });

		new Setting(containerEl)
			.setName("OpenAI API Key")
			.setDesc("Введи свой OpenAI API ключ (начинается с sk-...)")
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.openaiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Модель с поддержкой изображений (например, gpt-4o-mini или gpt-4o).")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4o-mini")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
						await this.plugin.saveSettings();
					})
			);
	}
}

// =============== UTILS ==================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}
	return btoa(binary);
}