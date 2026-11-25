import { InjectionToken, makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import type { ViewerOptions } from 'any-viewer';

/** Viewer options without the callbacks: the component reports through its outputs instead. */
export type AnyViewerOptions = Omit<ViewerOptions, 'onLoad' | 'onError'>;

/** Application-wide default options for every `<any-viewer>`. Provide them with {@link provideAnyViewer}. */
export const ANY_VIEWER_OPTIONS = new InjectionToken<AnyViewerOptions>('ANY_VIEWER_OPTIONS');

/**
 * Sets default options for every `<any-viewer>` in the application.
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideAnyViewer({ pdf: { assetsUrl: '/pdfjs/' }, uiLanguage: 'en' })],
 * });
 * ```
 *
 * Options passed to a component through `[options]` are merged over these defaults (shallowly).
 */
export function provideAnyViewer(options: AnyViewerOptions): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: ANY_VIEWER_OPTIONS, useValue: options }]);
}
