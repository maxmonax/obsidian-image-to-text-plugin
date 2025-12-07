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
					
					// Ждём немного, чтобы Obsidian успел создать заметку
					await new Promise(resolve => setTimeout(resolve, 1000));
					
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

	extractJsonFromText(text: string): string | null {
		if (!text || typeof text !== "string") return null;

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

	tryParseJson(text: string): any {
		const candidate = this.extractJsonFromText(text);
		if (!candidate) throw new Error("No JSON found in response text");

		const cleaned = candidate
			.replace(/^\u200B/g, "")
			.replace(/\u00A0/g, " ")
			.trim();

		try {
			return JSON.parse(cleaned);
		} catch (err) {
			const e: any = new Error("JSON.parse failed: " + (err as Error).message);
			e.candidate = cleaned;
			e.original = text;
			throw e;
		}
	}

	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:"*?<>|]+/g, "").trim() || "contact";
	}

	async findNoteWithImage(imageFile: TFile): Promise<TFile | null> {
		const embed = `![[${imageFile.name}]]`;
		const markdownFiles = this.app.vault.getMarkdownFiles();
		
		console.log(`markdownFiles:`, markdownFiles);
		
		for (const mdFile of markdownFiles) {
			console.log(`check md:`, mdFile.name);
			try {
				const content = await this.app.vault.read(mdFile);
				if (content.includes(embed)) {
					console.log(`✅ Found note with image: ${mdFile.name}`);
					return mdFile;
				}
			} catch (error) {
				console.error(`Error reading ${mdFile.name}:`, error);
			}
		}
		
		console.log(`❌ No note found with embed: ${embed}`);
		return null;
	}

	// Добавляем метод для определения MIME-типа
	getMimeType(file: TFile): string {
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
	
	async processImage(file: TFile) {
		try {
			const arrayBuffer = await this.app.vault.readBinary(file);
			const base64 = arrayBufferToBase64(arrayBuffer);

			// Определяем MIME-тип
			const mimeType = this.getMimeType(file);
	
			// Создаём data URL
			const dataUrl = `data:${mimeType};base64,${base64}`;
	
			// Вставляем как base64 в markdown
			const imageEmbed = `![${file.basename}](${dataUrl})`;

			if (!this.settings.openaiApiKey) {
				new Notice("⚠️ Please set your OpenAI API key in the plugin settings.");
				return;
			}

			new Notice(`📤 Sending ${file.name} to OpenAI...`);

			// Отправляем изображение в OpenAI
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
				const errorText = await response.text();
				throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
			}

			const data = await response.json();
			const content = data?.choices?.[0]?.message?.content ?? "{}";

			const parsed = this.tryParseJson(content);
			const name = parsed.name?.trim() || file.basename || "Unknown Contact";
			const safeName = this.sanitizeFileName(name);
			const imgName = safeName + "." + file.extension;

			new Notice(`✅ Recognized: ${name}`);

			// Ищем существующую заметку с этим изображением
			// const existingNote = await this.findNoteWithImage(file);

			// переименовываем картинку
			await this.app.vault.rename(file, imgName);

			let notePath: string;
			let noteContent: string;

			// Формируем содержимое заметки
			noteContent = 
				// `# ${name}\n\n` +
				// embed +
				// `\n\n---\n\n` +
				// `\n` +
				`**Компания:** ${parsed.company || "-"}\n` +
				`**Должность:** ${parsed.position || "-"}\n` +
				`**Телефоны:**\n${parsed.phones?.length ? parsed.phones.map((p: string) => `- ${p}`).join("\n") : "-"}\n` +
				`**Email:**\n${parsed.emails?.length ? parsed.emails.map((e: string) => `- ${e}`).join("\n") : "-"}\n` +
				`**Website:** ${parsed.website || "-"}\n` +
				`**Адрес:** ${parsed.address || "-"}\n\n` +
				`---\n\n` +
				`**Полный текст визитки:**\n${parsed.rawText || ""}\n` +
				imageEmbed;

			// if (existingNote) {
			// 	// Обновляем существующую заметку
			// 	await this.app.vault.modify(existingNote, noteContent);
			// 	new Notice(`📝 Updated existing note: ${existingNote.basename}`);
			// } else {
				// Создаём новую заметку рядом с изображением
				const folder = file.parent?.path ?? "";
				notePath = `${folder}/${safeName}.md`;
				
				// Проверяем, существует ли уже файл с таким именем
				const existingFile = this.app.vault.getAbstractFileByPath(notePath);
				if (existingFile instanceof TFile) {
					// Если файл существует, добавляем к имени номер
					let counter = 1;
					let newPath = notePath;
					while (this.app.vault.getAbstractFileByPath(newPath)) {
						newPath = `${folder}/${safeName} (${counter}).md`;
						counter++;
					}
					notePath = newPath;
				}
				
				await this.app.vault.create(notePath, noteContent);
				new Notice(`📄 Created new note: ${safeName}`);
			// }

			// await new Promise(resolve => setTimeout(resolve, 5000));

			// удаляем картинку
			await this.app.vault.delete(file);

		} catch (err) {
			console.error("Error processing image:", err);
			new Notice(`❌ Error processing ${file.name}: ${err.message}`);
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