import Element from '../nodes/element/Element';
import IDocument from '../nodes/document/IDocument';
import VoidElements from '../config/VoidElements';
import UnnestableElements from '../config/UnnestableElements';
import NamespaceURI from '../config/NamespaceURI';
import HTMLScriptElement from '../nodes/html-script-element/HTMLScriptElement';
import IElement from '../nodes/element/IElement';
import HTMLLinkElement from '../nodes/html-link-element/HTMLLinkElement';
import IDocumentFragment from '../nodes/document-fragment/IDocumentFragment';
import PlainTextElements from '../config/PlainTextElements';
import IDocumentType from '../nodes/document-type/IDocumentType';
import { decode } from 'he';

/**
 * Markup RegExp.
 *
 * Group 1: Comment (e.g. " Comment 1 " in "<!-- Comment 1 -->").
 * Group 2: Exclamation mark comment (e.g. "DOCTYPE html" in "<!DOCTYPE html>").
 * Group 3: Processing instruction target (e.g. "xml"" in "<?xml version="1.0"?>").
 * Group 4: Processing instruction data (e.g. "version="1.0"" in "<?xml version="1.0"?>").
 * Group 5: Start tag (e.g. "div" in "<div").
 * Group 6: Attribute name when the attribute has a value using double apostrophe (e.g. "name" in "<div name="value">").
 * Group 7: Attribute value when the attribute has a value using double apostrophe (e.g. "value" in "<div name="value">").
 * Group 8: Attribute name when the attribute has a value using single apostrophe (e.g. "name" in "<div name='value'>").
 * Group 9: Attribute value when the attribute has a value using single apostrophe (e.g. "value" in "<div name='value'>").
 * Group 10: Attribute name when the attribute has a value using no apostrophe (e.g. "name" in "<div name=value>").
 * Group 11: Attribute value when the attribute has a value using no apostrophe (e.g. "value" in "<div name=value>").
 * Group 12: Attribute name when the attribute has no value (e.g. "disabled" in "<div disabled>").
 * Group 13: Self-closing end of start tag (e.g. "/>" in "<div/>").
 * Group 14: End of start tag (e.g. ">" in "<div>").
 * Group 15: End tag (e.g. "div" in "</div>").
 */
const MARKUP_REGEXP =
	/<!--([^!]+)!-->|<!([^>]+)>|<\?([a-zA-Z0-9-]+) ([^?]+)\?>|<([a-zA-Z-]+)|([a-zA-Z0-9-_:]+) *= *"([^"]*)"|([a-zA-Z0-9-_:]+) *= *'([^']*)'|([a-zA-Z0-9-_:]+) *= *([^ >]*)|([a-zA-Z0-9-_:]+)|(\/>)|(>)|<\/([a-zA-Z-]+)>/gm;

/**
 * Document type attribute RegExp.
 *
 * Group 1: Attribute value.
 */
const DOCUMENT_TYPE_ATTRIBUTE_REGEXP = /"([^"]+)"/gm;

/**
 * XML parser.
 */
export default class XMLParser {
	/**
	 * Parses XML/HTML and returns a root element.
	 *
	 * @param document Document.
	 * @param data HTML data.
	 * @param [evaluateScripts = false] Set to "true" to enable script execution.
	 * @returns Root element.
	 */
	public static parse(
		document: IDocument,
		data: string,
		evaluateScripts = false
	): IDocumentFragment {
		const root = document.createDocumentFragment();
		const stack: Array<IElement | IDocumentFragment> = [root];
		const markupRegexp = new RegExp(MARKUP_REGEXP, 'gi');
		let currentElement: IElement | IDocumentFragment | null = root;
		let match: RegExpExecArray;
		let plainTextTagName: string | null = null;
		let unnestableTagName: string | null = null;
		let lastTagIndex = 0;
		let isStartTag = false;

		if (data !== null && data !== undefined) {
			data = String(data);

			while ((match = markupRegexp.exec(data))) {
				if (!currentElement) {
					return root;
				}

				if (!!plainTextTagName && match[15] && plainTextTagName === match[15].toUpperCase()) {
					// End of plain text tag.

					// Scripts are not allowed to be executed when they are parsed using innerHTML, outerHTML, replaceWith() etc.
					// However, they are allowed to be executed when document.write() is used.
					// See: https://developer.mozilla.org/en-US/docs/Web/API/HTMLScriptElement
					if (plainTextTagName === 'SCRIPT') {
						(<HTMLScriptElement>currentElement)._evaluateScript = evaluateScripts;
					} else if (plainTextTagName === 'LINK') {
						// An assumption that the same rule should be applied for the HTMLLinkElement is made here.
						(<HTMLLinkElement>currentElement)._evaluateCSS = evaluateScripts;
					}

					// Plain text elements such as <script> and <style> should only contain text.
					currentElement.appendChild(
						document.createTextNode(data.substring(lastTagIndex, match.index))
					);

					plainTextTagName = null;
				} else if (!plainTextTagName) {
					if (!isStartTag) {
						if (match.index !== lastTagIndex) {
							// Text.

							currentElement.appendChild(
								document.createTextNode(data.substring(lastTagIndex, match.index))
							);
						}

						if (match[1]) {
							// Comment.

							lastTagIndex = markupRegexp.lastIndex;
							currentElement.appendChild(document.createComment(match[1]));
						} else if (match[2]) {
							// Exclamation mark comment.

							lastTagIndex = markupRegexp.lastIndex;
							currentElement.appendChild(
								this._getDocumentTypeNode(document, match[2]) || document.createComment(match[2])
							);
						} else if (match[3] && match[4]) {
							// Processing instruction.

							lastTagIndex = markupRegexp.lastIndex;
							currentElement.appendChild(document.createProcessingInstruction(match[3], match[4]));
						} else if (match[5]) {
							// Start tag.

							const startTag = match[5].toUpperCase();

							// Some elements are not allowed to be nested (e.g. "<a><a></a></a>" is not allowed.).
							// Therefore we need to auto-close the tag, so that it become valid (e.g. "<a></a><a></a>").
							if (!!unnestableTagName && unnestableTagName === startTag) {
								currentElement = stack.pop() || null;

								if (
									currentElement &&
									UnnestableElements.includes((<IElement>currentElement).tagName)
								) {
									unnestableTagName = (<IElement>currentElement).tagName;
								}
							}

							// NamespaceURI is inherited from the parent element.
							// It should default to SVG for SVG elements.
							const namespaceURI =
								startTag === 'SVG' ? NamespaceURI.svg : (<IElement>currentElement).namespaceURI;
							const newElement = document.createElementNS(namespaceURI, startTag);

							currentElement.appendChild(newElement);
							currentElement = newElement;
							isStartTag = true;
						} else if (match[15]) {
							// End tag.

							// Some elements are not allowed to be nested (e.g. "<a><a></a></a>" is not allowed.).
							// Therefore we need to auto-close the tag, so that it become valid (e.g. "<a></a><a></a>").
							if (unnestableTagName && (<IElement>currentElement).tagName === unnestableTagName) {
								unnestableTagName = null;
							}

							currentElement = stack.pop() || null;
							lastTagIndex = markupRegexp.lastIndex;

							if (
								currentElement &&
								UnnestableElements.includes((<IElement>currentElement).tagName)
							) {
								unnestableTagName = (<IElement>currentElement).tagName;
							}
						}
					} else {
						if (
							(match[6] && match[7]) ||
							(match[8] && match[9]) ||
							(match[10] && match[11]) ||
							match[12]
						) {
							// Attribute name and value.

							const attributeName = match[6] || match[8] || match[10] || match[12];
							const attributeValue = match[12] ? '' : decode(match[7] || match[9] || match[11]);

							// @see https://developer.mozilla.org/en-US/docs/Web/SVG/Namespaces_Crash_Course
							if (attributeName === 'xmlns') {
								(<string>currentElement['namespaceURI']) = attributeValue;
								for (const name of Object.keys((<Element>currentElement)._attributes)) {
									const attr = (<Element>currentElement)._attributes;
									if (attr[name].namespaceURI === null) {
										attr[name].namespaceURI = attributeValue;
									}
								}
							}

							(<IElement>currentElement).setAttributeNS(
								(<IElement>currentElement).namespaceURI,
								attributeName,
								attributeValue
							);
						} else if (match[13]) {
							// Self-closing end of start tag.

							isStartTag = false;
							lastTagIndex = markupRegexp.lastIndex;
						} else if (match[14]) {
							// End of start tag.

							if (!VoidElements.includes((<IElement>currentElement).tagName)) {
								// Plain text elements such as <script> and <style> should only contain text.
								plainTextTagName = PlainTextElements.includes((<IElement>currentElement).tagName)
									? (<IElement>currentElement).tagName
									: null;
								lastTagIndex = markupRegexp.lastIndex;

								if (!plainTextTagName) {
									stack.push(currentElement);
								}

								if (UnnestableElements.includes((<IElement>currentElement).tagName)) {
									unnestableTagName = (<IElement>currentElement).tagName;
								}
							}

							isStartTag = false;
							lastTagIndex = markupRegexp.lastIndex;
						}
					}
				}
			}
		}

		return root;
	}

	/**
	 * Returns document type node.
	 *
	 * @param document Document.
	 * @param value Value.
	 * @returns Document type node.
	 */
	private static _getDocumentTypeNode(document: IDocument, value: string): IDocumentType {
		if (!value.toUpperCase().startsWith('DOCTYPE')) {
			return null;
		}

		const docTypeSplit = value.split(' ');

		if (docTypeSplit.length <= 1) {
			return null;
		}

		const docTypeString = docTypeSplit.slice(1).join(' ');
		const attributes = [];
		const attributeRegExp = new RegExp(DOCUMENT_TYPE_ATTRIBUTE_REGEXP, 'gm');
		const isPublic = docTypeString.includes('PUBLIC');
		let attributeMatch;

		while ((attributeMatch = attributeRegExp.exec(docTypeString))) {
			attributes.push(attributeMatch[1]);
		}

		const publicId = isPublic ? attributes[0] || '' : '';
		const systemId = isPublic ? attributes[1] || '' : attributes[0] || '';

		return document.implementation.createDocumentType(docTypeSplit[1], publicId, systemId);
	}
}
