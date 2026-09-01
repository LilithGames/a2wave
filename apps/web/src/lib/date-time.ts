export function localeForLanguage(language: string): 'zh-CN' | 'en-US' {
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function formatLocaleTime(value: string | number | Date, language: string): string {
  return new Date(value).toLocaleTimeString(localeForLanguage(language))
}
