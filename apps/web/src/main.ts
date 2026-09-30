import 'element-plus/dist/index.css'
import './styles.css'

import { i18n } from '@mlightcad/cad-viewer'
import ElementPlus from 'element-plus'
import { createApp } from 'vue'

import App from './App.vue'
// Side-effectful: registers acadrust as cad-viewer's DWG converter. Imported
// before the app mounts so no file open can beat the registration.
import './lib/acadrust'

createApp(App).use(ElementPlus).use(i18n).mount('#app')

// The boot loader lives in index.html so users see progress before the JS
// bundle loads.
document.getElementById('boot-loader')?.remove()
