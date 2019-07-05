import debounce from 'lodash/debounce';
import * as vscode from 'vscode';
import { window, workspace } from 'vscode';

import { IAggregatedDiagnostics, IConfig, IExcludeObject } from './types';
import { isObject, truncate } from './utils';

const EXTNAME = 'errorLens';

export function activate(context: vscode.ExtensionContext) {
	let config = workspace.getConfiguration(EXTNAME) as any as IConfig;
	let excludeRegexp: RegExp[] = [];
	let excludeSourceAndCode: IExcludeObject[] = [];
	let errorLensEnabled = true;
	let lastSavedTimestamp = Date.now() + 4000;

	let decorationTypeError: vscode.TextEditorDecorationType;
	let decorationTypeWarning: vscode.TextEditorDecorationType;
	let decorationTypeInfo: vscode.TextEditorDecorationType;
	let decorationTypeHint: vscode.TextEditorDecorationType;

	let onDidChangeDiagnosticsDisposable: vscode.Disposable;
	let onDidSaveTextDocumentDisposable: vscode.Disposable;

	setDecorationStyle();

	const disposableToggleErrorLens = vscode.commands.registerCommand('errorLens.toggle', () => {
		errorLensEnabled = !errorLensEnabled;
		updateAllDecorations();
	});

	window.onDidChangeActiveTextEditor(textEditor => {
		if (textEditor) {
			updateDecorationsForUri(textEditor.document.uri, textEditor);
		}
	}, undefined, context.subscriptions);

	function onChangedDiagnostics(diagnosticChangeEvent: vscode.DiagnosticChangeEvent) {
		// Many URIs can change - we only need to decorate all visible editors
		for (const uri of diagnosticChangeEvent.uris) {
			for (const editor of window.visibleTextEditors) {
				if (uri.fsPath === editor.document.uri.fsPath) {
					updateDecorationsForUri(uri, editor);
				}
			}
		}
	}

	updateExclude();
	updateChangeDiagnosticListener();
	updateOnSaveListener();

	function updateChangeDiagnosticListener() {
		if (onDidChangeDiagnosticsDisposable) {
			onDidChangeDiagnosticsDisposable.dispose();
		}
		if (config.onSave) {
			onDidChangeDiagnosticsDisposable = vscode.languages.onDidChangeDiagnostics(e => {
				if ((Date.now() - lastSavedTimestamp) < 1000) {
					onChangedDiagnostics(e);
				}
			});
			return;
		}
		if (typeof config.delay === 'number' && config.delay > 0) {
			const debouncedOnChangeDiagnostics = debounce(onChangedDiagnostics, config.delay);
			const onChangedDiagnosticsDebounced = (diagnosticChangeEvent: vscode.DiagnosticChangeEvent) => {
				if (config.clearDecorations) {
					clearAllDecorations();
				}
				debouncedOnChangeDiagnostics(diagnosticChangeEvent);
			};
			onDidChangeDiagnosticsDisposable = vscode.languages.onDidChangeDiagnostics(onChangedDiagnosticsDebounced);
		} else {
			onDidChangeDiagnosticsDisposable = vscode.languages.onDidChangeDiagnostics(onChangedDiagnostics);
		}
	}
	function updateOnSaveListener() {
		if (onDidSaveTextDocumentDisposable) {
			onDidSaveTextDocumentDisposable.dispose();
		}
		if (!config.onSave) {
			return;
		}
		onDidSaveTextDocumentDisposable = workspace.onDidSaveTextDocument(onSaveDocument);
	}
	function onSaveDocument(e: vscode.TextDocument) {
		lastSavedTimestamp = Date.now();
		setTimeout(() => {
			updateDecorationsForUri(e.uri);
		}, 600);
	}

	/**
     * Update the editor decorations for the provided URI. Only if the URI scheme is "file" is the function
     * processed. (It can be others, such as "git://<something>", in which case the function early-exits).
     */
	function updateDecorationsForUri(uriToDecorate : vscode.Uri, editor?: vscode.TextEditor) {
		if (!uriToDecorate) {
			return;
		}

		if ((uriToDecorate.scheme !== 'file') && (uriToDecorate.scheme !== 'untitled')) {
			return;
		}

		const activeTextEditor = window.activeTextEditor;
		if (editor === undefined) {
			editor = activeTextEditor;// tslint:disable-line
		}
		if (!editor) {
			return;
		}

		if (!editor.document.uri.fsPath) {
			return;
		}

		const decorationOptionsError: vscode.DecorationOptions[] = [];
		const decorationOptionsWarning: vscode.DecorationOptions[] = [];
		const decorationOptionsInfo: vscode.DecorationOptions[] = [];
		const decorationOptionsHint: vscode.DecorationOptions[] = [];

		// The aggregatedDiagnostics object will contain one or more objects, each object being keyed by "N",
		// where N is the source line where one or more diagnostics are being reported.
		// Each object which is keyed by "N" will contain one or more arrayDiagnostics[] array of objects.
		// This facilitates gathering info about lines which contain more than one diagnostic.
		// {
		//     67: [
		//         <vscode.Diagnostic #1>,
		//         <vscode.Diagnostic #2>
		//     ],
		//     93: [
		//         <vscode.Diagnostic #1>
		//     ]
		// };

		if (errorLensEnabled) {
			const aggregatedDiagnostics: IAggregatedDiagnostics = {};
			// Iterate over each diagnostic that VS Code has reported for this file. For each one, add to
			// a list of objects, grouping together diagnostics which occur on a single line.
			nextDiagnostic:
			for (const diagnostic of vscode.languages.getDiagnostics(uriToDecorate)) {
				// Exclude items specified in `errorLens.exclude` setting
				for (const regex of excludeRegexp) {
					if (regex.test(diagnostic.message)) {
						continue nextDiagnostic;
					}
				}
				for (const excludeItem of excludeSourceAndCode) {
					if (diagnostic.source === excludeItem.source &&
						String(diagnostic.code) === excludeItem.code) {
						continue nextDiagnostic;
					}
				}

				const key = diagnostic.range.start.line;

				if (aggregatedDiagnostics[key]) {
					// Already added an object for this key, so augment the arrayDiagnostics[] array.
					aggregatedDiagnostics[key].push(diagnostic);
				} else {
					// Create a new object for this key, specifying the line: and a arrayDiagnostics[] array
					aggregatedDiagnostics[key] = [diagnostic];
				}
			}

			for (const key in aggregatedDiagnostics) {
				const aggregatedDiagnostic = aggregatedDiagnostics[key];
				let messagePrefix = '';

				if (config.addAnnotationTextPrefixes) {
					if (aggregatedDiagnostic.length > 1) {
						// If > 1 diagnostic for this source line, the prefix is "Diagnostic #1 of N: "
						messagePrefix += 'Diagnostic 1/' + String(aggregatedDiagnostic.length) + ': ';
					} else {
						// If only 1 diagnostic for this source line, show the diagnostic severity
						switch (aggregatedDiagnostic[0].severity) {
							case 0:
								messagePrefix += 'ERROR: ';
								break;

							case 1:
								messagePrefix += 'WARNING: ';
								break;

							case 2:
								messagePrefix += 'INFO: ';
								break;

							case 3:
							default:
								messagePrefix += 'HINT: ';
								break;
						}
					}
				}

				let addErrorLens = false;
				switch (aggregatedDiagnostic[0].severity) {
					// Error
					case 0:
						if (config.enabledDiagnosticLevels.indexOf('error') !== -1) {
							addErrorLens = true;
						}
						break;
					// Warning
					case 1:
						if (config.enabledDiagnosticLevels.indexOf('warning') !== -1) {
							addErrorLens = true;
						}
						break;
					// Info
					case 2:
						if (config.enabledDiagnosticLevels.indexOf('info') !== -1) {
							addErrorLens = true;
						}
						break;
					// Hint
					case 3:
						if (config.enabledDiagnosticLevels.indexOf('hint') !== -1) {
							addErrorLens = true;
						}
						break;
				}

				if (addErrorLens) {
					// Generate a DecorationInstanceRenderOptions object which specifies the text which will be rendered
					// after the source-code line in the editor
					const decInstanceRenderOptions: vscode.DecorationInstanceRenderOptions = {
						after: {
							contentText: truncate(messagePrefix + aggregatedDiagnostic[0].message),
						},
					};

					const diagnosticDecorationOptions: vscode.DecorationOptions = {
						range: aggregatedDiagnostic[0].range,
						renderOptions: decInstanceRenderOptions,
					};

					switch (aggregatedDiagnostic[0].severity) {
						// Error
						case 0:
							decorationOptionsError.push(diagnosticDecorationOptions);
							break;
						// Warning
						case 1:
							decorationOptionsWarning.push(diagnosticDecorationOptions);
							break;
						// Info
						case 2:
							decorationOptionsInfo.push(diagnosticDecorationOptions);
							break;
						// Hint
						case 3:
							decorationOptionsHint.push(diagnosticDecorationOptions);
							break;
					}
				}
			}
		}

		// The errorLensDecorationOptions<X> arrays have been built, now apply them.
		editor.setDecorations(decorationTypeError, decorationOptionsError);
		editor.setDecorations(decorationTypeWarning, decorationOptionsWarning);
		editor.setDecorations(decorationTypeInfo, decorationOptionsInfo);
		editor.setDecorations(decorationTypeHint, decorationOptionsHint);
	}

	function clearAllDecorations() {
		for (const editor of window.visibleTextEditors) {
			editor.setDecorations(decorationTypeError, []);
			editor.setDecorations(decorationTypeWarning, []);
			editor.setDecorations(decorationTypeInfo, []);
			editor.setDecorations(decorationTypeHint, []);
		}
	}

	function updateConfig(e: vscode.ConfigurationChangeEvent) {
		if (!e.affectsConfiguration(EXTNAME)) return;

		config = workspace.getConfiguration(EXTNAME) as any as IConfig;

		decorationTypeError.dispose();
		decorationTypeWarning.dispose();
		decorationTypeInfo.dispose();
		decorationTypeHint.dispose();

		updateExclude();
		updateChangeDiagnosticListener();
		updateOnSaveListener();
		setDecorationStyle();
		updateAllDecorations();
	}

	function updateExclude() {
		excludeRegexp = [];
		excludeSourceAndCode = [];

		for (const item of config.exclude) {
			if (typeof item === 'string') {
				excludeRegexp.push(new RegExp(item, 'i'));
			} else if (isObject(item)) {
				excludeSourceAndCode.push(item);
			}
		}
	}

	function setDecorationStyle() {
		const gutterIconSize = config.gutterIconSize;

		let gutterIconSet = config.gutterIconSet;
		if (config.gutterIconSet !== 'borderless' &&
			config.gutterIconSet !== 'default' &&
			config.gutterIconSet !== 'circle') {
				gutterIconSet = 'default';
		}

		let errorGutterIconPath;
		let errorGutterIconPathLight;
		let warningGutterIconPath;
		let warningGutterIconPathLight;
		let infoGutterIconPath;
		let infoGutterIconPathLight;

		let errorGutterIconSize = gutterIconSize;
		let errorGutterIconSizeLight = gutterIconSize;
		let warningGutterIconSize = gutterIconSize;
		let warningGutterIconSizeLight = gutterIconSize;
		let infoGutterIconSize = gutterIconSize;
		let infoGutterIconSizeLight = gutterIconSize;

		if (config.gutterIconsEnabled) {
			if (gutterIconSet === 'circle') {
				errorGutterIconSize = getGutterCircleSizeAndColor(config.errorGutterIconColor);
				errorGutterIconSizeLight = getGutterCircleSizeAndColor(config.errorGutterIconColorLight);
				warningGutterIconSize = getGutterCircleSizeAndColor(config.warningGutterIconColor);
				warningGutterIconSizeLight = getGutterCircleSizeAndColor(config.warningGutterIconColorLight);
				infoGutterIconSize = getGutterCircleSizeAndColor(config.infoGutterIconColor);
				infoGutterIconSizeLight = getGutterCircleSizeAndColor(config.infoGutterIconColorLight);
			}
			// ERROR
			if (config.errorGutterIconPath) {
				errorGutterIconPath = config.errorGutterIconPath;
			} else {
				errorGutterIconPath = context.asAbsolutePath(`./img/${gutterIconSet}/error-inverse.svg`);
			}
			if (config.errorGutterIconPathLight) {
				errorGutterIconPathLight = config.errorGutterIconPathLight;
			} else {
				errorGutterIconPathLight = context.asAbsolutePath(`./img/${gutterIconSet}/error.svg`);
			}
			// WARNING
			if (config.warningGutterIconPath) {
				warningGutterIconPath = config.warningGutterIconPath;
			} else {
				warningGutterIconPath = context.asAbsolutePath(`./img/${gutterIconSet}/warning-inverse.svg`);
			}
			if (config.warningGutterIconPathLight) {
				warningGutterIconPathLight = config.warningGutterIconPathLight;
			} else {
				warningGutterIconPathLight = context.asAbsolutePath(`./img/${gutterIconSet}/warning.svg`);
			}
			// INFO
			if (config.infoGutterIconPath) {
				infoGutterIconPath = config.infoGutterIconPath;
			} else {
				infoGutterIconPath = context.asAbsolutePath(`./img/${gutterIconSet}/info-inverse.svg`);
			}
			if (config.infoGutterIconPathLight) {
				infoGutterIconPathLight = config.infoGutterIconPathLight;
			} else {
				infoGutterIconPathLight = context.asAbsolutePath(`./img/${gutterIconSet}/info.svg`);
			}
		}
		const afterProps = {
			fontStyle: config.fontStyle,
			margin: config.margin,
			fontWeight: config.fontWeight,
			textDecoration: `;font-family:${config.fontFamily};font-size:${config.fontSize};line-height:1;`,
		};
		decorationTypeError = window.createTextEditorDecorationType({
			backgroundColor: config.errorBackground,
			gutterIconSize: errorGutterIconSize,
			gutterIconPath: errorGutterIconPath,
			after: {
				...afterProps,
				color: config.errorForeground,
			},
			light: {
				backgroundColor: config.light.errorBackground || config.errorBackground,
				gutterIconSize: errorGutterIconSizeLight,
				gutterIconPath: errorGutterIconPathLight,
				after: {
					color: config.light.errorForeground || config.errorForeground,
				},
			},
			isWholeLine: true,
		});
		decorationTypeWarning = window.createTextEditorDecorationType({
			backgroundColor: config.warningBackground,
			gutterIconSize: warningGutterIconSize,
			gutterIconPath: warningGutterIconPath,
			after: {
				...afterProps,
				color: config.warningForeground,
			},
			light: {
				backgroundColor: config.light.warningBackground || config.warningBackground,
				gutterIconSize: warningGutterIconSizeLight,
				gutterIconPath: warningGutterIconPathLight,
				after: {
					color: config.light.warningForeground || config.warningForeground,
				},
			},
			isWholeLine: true,
		});
		decorationTypeInfo = window.createTextEditorDecorationType({
			backgroundColor: config.infoBackground,
			gutterIconSize: infoGutterIconSize,
			gutterIconPath: infoGutterIconPath,
			after: {
				...afterProps,
				color: config.infoForeground,
			},
			light: {
				backgroundColor: config.light.infoBackground || config.infoBackground,
				gutterIconSize: infoGutterIconSizeLight,
				gutterIconPath: infoGutterIconPathLight,
				after: {
					color: config.light.infoForeground || config.infoForeground,
				},
			},
			isWholeLine: true,
		});
		decorationTypeHint = window.createTextEditorDecorationType({
			backgroundColor: config.hintBackground,
			after: {
				...afterProps,
				color: config.hintForeground,
			},
			light: {
				backgroundColor: config.light.hintBackground || config.hintBackground,
				after: {
					color: config.light.hintForeground || config.hintForeground,
				},
			},
			isWholeLine: true,
		});
	}

	function updateAllDecorations() {
		for (const editor of window.visibleTextEditors) {
			updateDecorationsForUri(editor.document.uri, editor);
		}
	}

	context.subscriptions.push(workspace.onDidChangeConfiguration(updateConfig, EXTNAME));
	context.subscriptions.push(disposableToggleErrorLens);

	function getGutterCircleSizeAndColor(color: string): string {
		return `${config.gutterIconSize};background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" height="30" width="30"><circle cx="15" cy="15" r="9" fill="${color}"/></svg>');`;
	}
}

export function deactivate() {}
