import { h, setVisible } from '../dom';
import type { Screen, UIHost } from '../host';
import { logo } from './Logo';

/** "Tap to start" over the showcase city. The first gesture unlocks audio (and fullscreen on phones). */
export class TitleScreen implements Screen {
  readonly el: HTMLDivElement;
  private prompt: HTMLDivElement;

  constructor(
    private host: UIHost,
    private onStart: () => void,
  ) {
    this.prompt = h('div', { class: 'title-prompt' }, h('span', { class: 'tp-text', text: 'Tap to start' }));
    this.el = h(
      'div',
      { class: 'screen title-screen', 'aria-hidden': 'true' },
      h('div', { class: 'title-vignette' }),
      h('div', { class: 'title-center' }, logo('logo-xl'), this.prompt, h('div', { class: 'title-hint' })),
    );
    const start = (e: Event) => {
      if (!this.el.classList.contains('visible')) return;
      e.preventDefault();
      this.onStart();
    };
    this.el.addEventListener('pointerup', start);
    this.el.addEventListener('keydown', start);
  }

  setVisible(on: boolean): void {
    if (on) {
      const touch = this.host.touchMode();
      this.prompt.querySelector('.tp-text')!.textContent = touch ? 'Tap to start' : 'Click or press any key';
      (this.el.querySelector('.title-hint') as HTMLElement).textContent = touch
        ? 'Best in landscape · sound on'
        : 'Keyboard, mouse or gamepad · sound on';
    }
    setVisible(this.el, on);
  }
}
