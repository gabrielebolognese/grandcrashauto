import { h, setVisible } from '../dom';
import type { ConfirmOpts, Screen } from '../host';
import { button } from '../widgets';

/** In-game confirm dialog (never window.confirm). */
export class ConfirmDialog implements Screen {
  readonly el: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private msgEl: HTMLParagraphElement;
  private okBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;
  open = false;

  constructor() {
    this.titleEl = h('div', { class: 'cd-title' });
    this.msgEl = h('p', { class: 'cd-msg' });
    this.cancelBtn = button('Cancel', { variant: 'ghost', sound: 'back', onClick: () => this.finish(false) });
    this.okBtn = button('OK', { variant: 'danger', sound: 'confirm', onClick: () => this.finish(true) });
    this.el = h(
      'div',
      { class: 'screen confirm-dialog', 'aria-hidden': 'true', role: 'alertdialog' },
      h('div', { class: 'cd-backdrop' }),
      h('div', { class: 'panel cd-panel' }, this.titleEl, this.msgEl, h('div', { class: 'cd-actions' }, this.cancelBtn, this.okBtn)),
    );
  }

  ask(o: ConfirmOpts): Promise<boolean> {
    this.finish(false);
    this.titleEl.textContent = o.title;
    this.msgEl.textContent = o.message;
    this.okBtn.querySelector('.btn-label')!.textContent = o.confirm;
    this.cancelBtn.querySelector('.btn-label')!.textContent = o.cancel ?? 'Cancel';
    this.okBtn.className = `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`;
    this.open = true;
    this.setVisible(true);
    return new Promise((r) => (this.resolve = r));
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
  }

  back(): boolean {
    this.finish(false);
    return true;
  }

  private finish(v: boolean): void {
    const r = this.resolve;
    this.resolve = null;
    if (this.open) {
      this.open = false;
      this.setVisible(false);
    }
    r?.(v);
  }
}
