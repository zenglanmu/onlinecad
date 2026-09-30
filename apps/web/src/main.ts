import 'element-plus/dist/index.css'
import './styles.css'

import ElementPlus from 'element-plus'
import { createApp } from 'vue'

import App from './App.vue'
// Cheap by design — it only holds dynamic imports, so importing it does not
// pull in the viewer or the DWG engine on the start-up page.
import { bindCadApp } from './lib/cad'

const app = createApp(App).use(ElementPlus)
bindCadApp(app)
app.mount('#app')

/*
 * `@mlightcad/cad-viewer` drives the page theme from the open drawing's colour
 * theme and reflects it as `html.dark`. This app's chrome is light-only, so the
 * leaked dark palette repaints Element Plus surfaces dark while the app's own
 * text and cards stay light — the drawing-register title, for instance, ends up
 * dark-on-dark and unreadable. Keep the document light; the CAD canvas is
 * unaffected because it is painted by the renderer, not by CSS.
 */
const root = document.documentElement

/**
 * Drop `dark` only when it is actually present.
 *
 * The guard is load-bearing, not a micro-optimisation. Writing the class
 * attribute from inside a `MutationObserver` callback queues another mutation
 * record, so calling `classList.remove('dark')` unconditionally re-enters the
 * callback forever — a microtask loop that pegs the renderer and freezes the
 * page the moment a drawing opens, because cad-viewer sets the theme while
 * activating the document (`Wr` → `classList.toggle('dark', true)`) and then
 * re-syncs it on every document event. Leaving the DOM untouched once `dark` is
 * gone lets the loop drain.
 */
const keepLightChrome = (): void => {
  if (root.classList.contains('dark')) root.classList.remove('dark')
}

keepLightChrome()
new MutationObserver(keepLightChrome).observe(root, {
  attributes: true,
  attributeFilter: ['class']
})

// The boot loader lives in index.html so users see progress before the JS
// bundle loads.
document.getElementById('boot-loader')?.remove()
