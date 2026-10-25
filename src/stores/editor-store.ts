import { defineStore } from 'pinia'

export const useEditorStore = defineStore({
  id: 'editor',
  state: () => {
    return {
      statBlockColumns: 1,
      changelogShown: '',
      style: '2014', // this fork serves a 2014-rules campaign

      condenseImmunities: false,
    }
  },
  persist: {
    key: 'app.editor',
  },
})
