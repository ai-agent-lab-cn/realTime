"""Generate local synthetic speech fixtures; these are not human-speech acceptance data."""
import json
import subprocess
import wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'tests/fixtures/local'
CASES=[
 ('everyday','Samantha',170,'Could you please repeat the last sentence a little more slowly?',['请求放慢速度重复上一句']),
 ('technical','Daniel',170,'We need to improve the RAG retrieval pipeline, not replace the entire application.',['优化 RAG 检索流水线','不是替换整个应用']),
 ('numbers','Samantha',170,'The timeout is fifteen seconds, not fifty. Please keep three backup copies.',['15 秒而非 50 秒','3 份备份']),
 ('negation','Karen',170,'Do not delete the original files until the backup has been verified.',['验证备份前不要删除原文件']),
 ('long','Samantha',190,'When the connection is interrupted, keep the current subtitles on screen and let the user retry without losing the text that has already been confirmed.',['中断时保留字幕','重试不能丢失已确认内容']),
 ('acronyms','Daniel',170,'The agent uses embeddings to search the repository before opening a pull request.',['智能体使用嵌入检索仓库','随后提出 PR']),
 ('mixed','Tingting',155,'我们需要优化 RAG pipeline，但是不要修改已经确认的字幕。',['优化 RAG pipeline','不修改确认字幕']),
 ('mixed_numbers','Tingting',155,'这个 API 的 timeout 是十五秒，不是五十秒。',['API 超时 15 秒而非 50 秒']),
]
DEST.mkdir(parents=True,exist_ok=True)
(ROOT/'work/local-runtime').mkdir(parents=True,exist_ok=True)
manifest=[]
for key,voice,rate,text,checks in CASES:
 aiff=ROOT/'work/local-runtime'/f'{key}.aiff'
 wav=DEST/f'{key}.wav'
 subprocess.run(['say','-v',voice,'-r',str(rate),'-o',str(aiff),text],check=True)
 subprocess.run(['afconvert','-f','WAVE','-d','LEI16@16000','-c','1',str(aiff),str(wav)],check=True)
 with wave.open(str(wav)) as f:duration=f.getnframes()/f.getframerate()
 manifest.append(dict(id=key,file=f'tests/fixtures/local/{key}.wav',source='macOS local TTS, synthetic',voice=voice,rate=rate,reference=text,semantic_checks=checks,duration=duration))
 print(key,round(duration,2),flush=True)
with wave.open(str(DEST/'silence.wav'),'wb') as f:
 f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(b'\0'*16000*2*4)
manifest.append(dict(id='silence',file='tests/fixtures/local/silence.wav',source='generated zero PCM',reference='',semantic_checks=['不应出现语音内容'],duration=4))
(DEST/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
