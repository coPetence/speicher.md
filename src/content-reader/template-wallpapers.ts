import { islandUrl } from './assets.controller';

/** A photo a template ships as its default wallpaper */
export interface TemplatePhoto {
  file: string;
  photographer: string;
  source: string;
}

export const TEMPLATE_WALLPAPERS: Record<string, { light: TemplatePhoto; dark: TemplatePhoto }> = {
  glass: {
    light: {
      file: 'daniele-buso-qzUenL35ZYw',
      photographer: 'Daniele Buso',
      source: 'https://unsplash.com/photos/qzUenL35ZYw',
    },
    dark: {
      file: 'benjamin-voros-phIFdC6lA4E',
      photographer: 'Benjamin Voros',
      source: 'https://unsplash.com/photos/phIFdC6lA4E',
    },
  },
};

/** Whether a template ships wallpapers of its own */
export function hasTemplateWallpapers(template: string): boolean {
  return TEMPLATE_WALLPAPERS[template] !== undefined;
}

/**
 * The URLs of a template's default wallpapers, or nulls when it ships none
 *
 * @param template the name of the template in use
 */
export function templateWallpaperUrls(template: string): {
  light: string | null;
  dark: string | null;
} {
  const photos = TEMPLATE_WALLPAPERS[template];
  if (!photos) return { light: null, dark: null };
  return {
    light: islandUrl(`wallpaper-${photos.light.file}`),
    dark: islandUrl(`wallpaper-${photos.dark.file}`),
  };
}
