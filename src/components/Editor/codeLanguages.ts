import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/**
 * Language parsers used by Markdown fenced code blocks.
 *
 * The stock language-data entry loads PHP as an HTML template language. That
 * is correct for a .php file, but a Markdown fence normally contains only PHP
 * source and no `<?php` tag. Loading the parser in plain mode keeps those
 * common fences from being treated as unstyled HTML text.
 */
const plainPhp = LanguageDescription.of({
  name: "PHP",
  alias: ["php"],
  extensions: ["php", "php3", "php4", "php5", "php7", "phtml"],
  load: () => import("@codemirror/lang-php").then(({ php }) => php({ plain: true })),
});

export const codeLanguages = [
  plainPhp,
  ...languages.filter((language) => language.name.toLowerCase() !== "php"),
];
