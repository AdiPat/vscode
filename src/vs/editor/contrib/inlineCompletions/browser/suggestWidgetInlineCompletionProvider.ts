/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { compareBy, findMaxBy, numberComparator } from 'vs/base/common/arrays';
import { Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { IActiveCodeEditor } from 'vs/editor/browser/editorBrowser';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { CompletionItemInsertTextRule, CompletionItemKind } from 'vs/editor/common/languages';
import { SnippetParser } from 'vs/editor/contrib/snippet/browser/snippetParser';
import { SnippetSession } from 'vs/editor/contrib/snippet/browser/snippetSession';
import { CompletionItem } from 'vs/editor/contrib/suggest/browser/suggest';
import { SuggestController } from 'vs/editor/contrib/suggest/browser/suggestController';
import { minimizeInlineCompletion, NormalizedInlineCompletion, normalizedInlineCompletionsEquals } from './inlineCompletionToGhostText';
import { IObservable, observableValue, transaction } from 'vs/base/common/observable';

export interface SuggestWidgetState {
	/**
	 * Represents the currently selected item in the suggest widget as inline completion, if possible.
	*/
	selectedItem: SuggestItemInfo | undefined;
}

export interface SuggestItemInfo {
	normalizedInlineCompletion: NormalizedInlineCompletion;
	isSnippetText: boolean;
	completionItemKind: CompletionItemKind;
}

export class SuggestWidgetInlineCompletionProvider extends Disposable {
	private isSuggestWidgetVisible: boolean = false;
	private isShiftKeyPressed = false;
	private _isActive = false;
	private _currentSuggestItemInfo: SuggestItemInfo | undefined = undefined;

	private readonly _state = observableValue('suggestWidgetInlineCompletionProvider.state', undefined as SuggestWidgetState | undefined);

	public get state(): IObservable<SuggestWidgetState | undefined> {
		return this._state;
	}

	constructor(
		private readonly editor: IActiveCodeEditor,
		private readonly suggestControllerPreselector: () => NormalizedInlineCompletion | undefined
	) {
		super();

		// See the command acceptAlternativeSelectedSuggestion that is bound to shift+tab
		this._register(editor.onKeyDown(e => {
			if (e.shiftKey && !this.isShiftKeyPressed) {
				this.isShiftKeyPressed = true;
				this.update(this._isActive);
			}
		}));
		this._register(editor.onKeyUp(e => {
			if (e.shiftKey && this.isShiftKeyPressed) {
				this.isShiftKeyPressed = false;
				this.update(this._isActive);
			}
		}));

		const suggestController = SuggestController.get(this.editor);
		if (suggestController) {
			this._register(suggestController.registerSelector({
				priority: 100,
				select: (model, pos, suggestItems) => {
					const textModel = this.editor.getModel();
					const normalizedItemToPreselect = minimizeInlineCompletion(textModel, this.suggestControllerPreselector());
					if (!normalizedItemToPreselect) {
						return -1;
					}
					const position = Position.lift(pos);

					const candidates = suggestItems
						.map((suggestItem, index) => {
							const inlineSuggestItem = suggestionToSuggestItemInfo(suggestController, position, suggestItem, this.isShiftKeyPressed);
							const normalizedSuggestItem = minimizeInlineCompletion(textModel, inlineSuggestItem?.normalizedInlineCompletion);
							if (!normalizedSuggestItem) {
								return undefined;
							}
							const valid = rangeStartsWith(normalizedItemToPreselect.range, normalizedSuggestItem.range) &&
								normalizedItemToPreselect.insertText.startsWith(normalizedSuggestItem.insertText);
							return { index, valid, prefixLength: normalizedSuggestItem.insertText.length, suggestItem };
						})
						.filter(item => item && item.valid);

					const result = findMaxBy(
						candidates,
						compareBy(s => s!.prefixLength, numberComparator)
					);
					return result ? result.index : - 1;
				}
			}));

			let isBoundToSuggestWidget = false;
			const bindToSuggestWidget = () => {
				if (isBoundToSuggestWidget) {
					return;
				}
				isBoundToSuggestWidget = true;

				this._register(suggestController.widget.value.onDidShow(() => {
					this.isSuggestWidgetVisible = true;
					this.update(true);
				}));
				this._register(suggestController.widget.value.onDidHide(() => {
					this.isSuggestWidgetVisible = false;
					this.update(false);
				}));
				this._register(suggestController.widget.value.onDidFocus(() => {
					this.isSuggestWidgetVisible = true;
					this.update(true);
				}));
			};

			this._register(Event.once(suggestController.model.onDidTrigger)(e => {
				bindToSuggestWidget();
			}));
		}
		this.update(this._isActive);
	}

	private update(newActive: boolean): void {
		const newInlineCompletion = this.getSuggestItemInfo();
		let shouldFire = false;
		if (!suggestItemInfoEquals(this._currentSuggestItemInfo, newInlineCompletion)) {
			this._currentSuggestItemInfo = newInlineCompletion;
			shouldFire = true;
		}
		if (this._isActive !== newActive) {
			this._isActive = newActive;
			shouldFire = true;
		}
		if (shouldFire) {
			transaction(tx => {
				this._state.set(this._isActive ? { selectedItem: this._currentSuggestItemInfo } : undefined, tx);
			});
		}
	}

	private getSuggestItemInfo(): SuggestItemInfo | undefined {
		const suggestController = SuggestController.get(this.editor);
		if (!suggestController) {
			return undefined;
		}
		if (!this.isSuggestWidgetVisible) {
			return undefined;
		}
		const focusedItem = suggestController.widget.value.getFocusedItem();
		if (!focusedItem) {
			return undefined;
		}

		// TODO: item.isResolved
		return suggestionToSuggestItemInfo(
			suggestController,
			this.editor.getPosition(),
			focusedItem.item,
			this.isShiftKeyPressed
		);
	}

	public stopForceRenderingAbove(): void {
		const suggestController = SuggestController.get(this.editor);
		suggestController?.stopForceRenderingAbove();
	}

	public forceRenderingAbove(): void {
		const suggestController = SuggestController.get(this.editor);
		suggestController?.forceRenderingAbove();
	}
}

export function rangeStartsWith(rangeToTest: Range, prefix: Range): boolean {
	return (
		prefix.startLineNumber === rangeToTest.startLineNumber &&
		prefix.startColumn === rangeToTest.startColumn &&
		(prefix.endLineNumber < rangeToTest.endLineNumber ||
			(prefix.endLineNumber === rangeToTest.endLineNumber &&
				prefix.endColumn <= rangeToTest.endColumn))
	);
}

function suggestItemInfoEquals(a: SuggestItemInfo | undefined, b: SuggestItemInfo | undefined): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return a.completionItemKind === b.completionItemKind &&
		a.isSnippetText === b.isSnippetText &&
		normalizedInlineCompletionsEquals(a.normalizedInlineCompletion, b.normalizedInlineCompletion);
}

function suggestionToSuggestItemInfo(suggestController: SuggestController, position: Position, item: CompletionItem, toggleMode: boolean): SuggestItemInfo | undefined {
	// additionalTextEdits might not be resolved here, this could be problematic.
	if (Array.isArray(item.completion.additionalTextEdits) && item.completion.additionalTextEdits.length > 0) {
		// cannot represent additional text edits. TODO: Now we can.
		return {
			completionItemKind: item.completion.kind,
			isSnippetText: false,
			normalizedInlineCompletion: {
				// Dummy element, so that space is reserved, but no text is shown
				range: Range.fromPositions(position, position),
				insertText: '',
				filterText: '',
				snippetInfo: undefined,
				additionalTextEdits: [],
			},
		};
	}

	let { insertText } = item.completion;
	let isSnippetText = false;
	if (item.completion.insertTextRules! & CompletionItemInsertTextRule.InsertAsSnippet) {
		const snippet = new SnippetParser().parse(insertText);
		const model = suggestController.editor.getModel()!;

		// Ignore snippets that are too large.
		// Adjust whitespace is expensive for them.
		if (snippet.children.length > 100) {
			return undefined;
		}

		SnippetSession.adjustWhitespace(model, position, true, snippet);
		insertText = snippet.toString();
		isSnippetText = true;
	}

	const info = suggestController.getOverwriteInfo(item, toggleMode);
	return {
		isSnippetText,
		completionItemKind: item.completion.kind,
		normalizedInlineCompletion: {
			insertText: insertText,
			filterText: insertText,
			range: Range.fromPositions(
				position.delta(0, -info.overwriteBefore),
				position.delta(0, Math.max(info.overwriteAfter, 0))
			),
			snippetInfo: undefined,
			additionalTextEdits: [],
		}
	};
}
