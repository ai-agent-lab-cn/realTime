<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CircleAlert } from 'lucide-vue-next'
defineProps<{ kind: 'restart' | 'clear'; message: string }>()
const emit = defineEmits<{ confirm: []; close: [] }>()
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
</script>
<template>
  <dialog ref="dialog" class="confirm-dialog" @cancel.prevent="emit('close')">
    <CircleAlert class="warning-icon" :size="28" />
    <h2>{{ kind === 'restart' ? '开始新一轮翻译？' : '清空当前记录？' }}</h2>
    <p>{{ message }}</p>
    <div class="dialog-actions">
      <button class="secondary" autofocus @click="emit('close')">取消</button
      ><button class="primary" @click="emit('confirm')">
        {{ kind === 'restart' ? '确认重新开始' : '确认清空' }}
      </button>
    </div>
  </dialog>
</template>
