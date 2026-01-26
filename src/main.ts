import { App, Plugin, PluginSettingTab, Setting, TFile, Notice } from "obsidian";
import { requestUrl } from "obsidian";

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
		console.debug("✅ ImageToTextPlugin loaded");

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
		console.debug("🛑 ImageToTextPlugin unloaded");
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

	tryParseJson(text: string) {
		const candidate = this.extractJsonFromText(text);
		if (!candidate) throw new Error("No JSON found in response text");

		const cleaned = candidate
			.replace(/^\u200B/g, "")
			.replace(/\u00A0/g, " ")
			.trim();

		try {
			return JSON.parse(cleaned);
		} catch (err) {
			const e = new Error("JSON.parse failed: " + (err as Error).message);
			throw e;
		}
	}

	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:"*?<>|]+/g, "").trim() || "contact";
	}

	async findNoteWithImage(imageFile: TFile): Promise<TFile | null> {
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
			} catch (error) {
				console.error(`Error reading ${mdFile.name}:`, error);
			}
		}

		console.debug(`❌ No note found with embed: ${embed}`);
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
			const originalBuffer = await this.app.vault.readBinary(file);
			const mimeType = this.getMimeType(file);

			const { rotation, buffer } = await detectBestRotation(
				originalBuffer,
				mimeType,
				this.settings.openaiApiKey
			);

			new Notice(`🧭 Image rotation detected: ${rotation}°`);

			const base64 = arrayBufferToBase64(buffer);

			// Создаём data URL
			const dataUrl = `data:${mimeType};base64,${base64}`;

			// Вставляем как base64 в markdown
			const imageEmbed = `![${file.basename}](${dataUrl})`;

			if (!this.settings.openaiApiKey) {
				new Notice("Please set your openai api key in the plugin settings.");
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

			// const response = await fetch("https://api.openai.com/v1/chat/completions", {
			// 	method: "POST",
			// 	headers: {
			// 		"Content-Type": "application/json",
			// 		"Authorization": `Bearer ${this.settings.openaiApiKey}`
			// 	},
			// 	body: JSON.stringify(payload)
			// });

			// if (!response.ok) {
			// 	const errorText = await response.text();
			// 	throw new Error(`Openai api error: ${response.status} ${errorText}`);
			// }

			// const data = await response.json();

			// use requestUrl from obsidian API instead of fetch
			const response = await requestUrl({
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

			new Notice(`✅ Recognized: ${name}`);

			// Ищем существующую заметку с этим изображением
			// const existingNote = await this.findNoteWithImage(file);

			// переименовываем картинку
			await this.app.vault.rename(file, imgName);

			let notePath: string;
			let noteContent: string;

			// Формируем содержимое заметки
			noteContent =
				`**Компания:** ${parsed.company || "-"}\n` +
				`**Должность:** ${parsed.position || "-"}\n` +
				`**Телефоны:**\n${parsed.phones?.length ? parsed.phones.map((p: string) => `- ${p}`).join("\n") : "-"}\n` +
				`**Email:**\n${parsed.emails?.length ? parsed.emails.map((e: string) => `- ${e}`).join("\n") : "-"}\n` +
				`**Website:** ${parsed.website || "-"}\n` +
				`**Адрес:** ${parsed.address || "-"}\n\n` +
				`---\n\n` +
				`**Полный текст визитки:**\n${parsed.rawText || ""}\n` +
				imageEmbed;

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

		// containerEl.createEl("h2", { text: "Image to text plugin settings" });
		new Setting(containerEl)
			.setName("Image to text plugin settings")
			.setHeading();

		new Setting(containerEl)
			.setName("Openai api key")
			.setDesc("Enter your openai api key (starts with sk-...)")
			.addText((text) =>
				text
					.setPlaceholder("Sk-...")
					.setValue(this.plugin.settings.openaiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("A model that supports images (e.g. gpt-4o-mini or gpt-4o). Default is gpt-4o-mini.")
			.addText((text) =>
				text
					.setPlaceholder("Gpt-4o-mini")
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

// Поворот изображения на заданный угол
async function rotateArrayBuffer(
	buffer: ArrayBuffer,
	degrees: number,
	mimeType: string
): Promise<ArrayBuffer> {
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
	} else {
		canvas.width = img.width;
		canvas.height = img.height;
	}

	ctx.translate(canvas.width / 2, canvas.height / 2);
	ctx.rotate((degrees * Math.PI) / 180);
	ctx.drawImage(img, -img.width / 2, -img.height / 2);

	return new Promise<ArrayBuffer>((resolve, reject) => {
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
async function scoreImageReadability(
	base64: string,
	apiKey: string
): Promise<number> {
	const payload = {
		model: "gpt-4o-mini",
		max_tokens: 10,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text:
							"Оцени, насколько удобно читать текст на изображении " +
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
	const response = await requestUrl({
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

// Поиск лучшего угла поворота
async function detectBestRotation(
	buffer: ArrayBuffer,
	mimeType: string,
	apiKey: string
): Promise<{ rotation: number; buffer: ArrayBuffer }> {

	const rotations = [0, 90, 180, 270];
	let bestScore = -1;
	let bestRotation = 0;
	let bestBuffer = buffer;

	for (const deg of rotations) {
		const rotatedBuffer =
			deg === 0 ? buffer : await rotateArrayBuffer(buffer, deg, mimeType);

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
