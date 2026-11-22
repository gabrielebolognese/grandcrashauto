import { Engine } from './core/Engine';
import { Game } from './game/Game';

function fatal(msg: string): void {
  const el = document.getElementById('fatal');
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  if (el) {
    el.querySelector('p')!.textContent = msg;
    el.style.display = 'flex';
  }
}

async function main(): Promise<void> {
  if (!Engine.supportsWebGL2()) {
    fatal('Your browser or device does not support WebGL 2, which this game needs. Try the latest Chrome, Safari or Firefox.');
    return;
  }
  const container = document.getElementById('app')!;
  try {
    const game = new Game(container);
    await game.boot();
  } catch (err) {
    console.error(err);
    fatal('Something went wrong while starting the game. Please reload the page.');
  }
}

main();
