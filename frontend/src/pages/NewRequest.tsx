import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Camera, X } from 'lucide-react';
import { errorMessage, useCreateRequestMutation } from '../app/api';
import { ErrorBox } from '../components/ui';

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function NewRequest() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [fileError, setFileError] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [create, { isLoading, error }] = useCreateRequestMutation();
  const navigate = useNavigate();

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  function add(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (!TYPES.includes(f.type)) { setFileError(`${f.name} isn’t a JPEG, PNG or WebP photo.`); continue; }
      if (f.size > MAX_BYTES) { setFileError(`${f.name} is larger than 5 MB.`); continue; }
      if (next.length >= MAX_FILES) { setFileError(`You can attach up to ${MAX_FILES} photos.`); break; }
      next.push(f);
      setFileError('');
    }
    setFiles(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const fd = new FormData();
    fd.append('title', title.trim());
    fd.append('description', description.trim());
    files.forEach((f) => fd.append('photos', f));
    try {
      const res = await create(fd).unwrap();
      navigate(`/requests/${res.id}`);
    } catch { /* shown below */ }
  }

  return (
    <>
      <Link to="/" className="back"><ArrowLeft size={16} aria-hidden />My requests</Link>
      <div className="page-head">
        <div>
          <h1>Report a problem</h1>
          <p>Describe what’s wrong and where. A photo helps the technician bring the right parts.</p>
        </div>
      </div>
      <form className="panel panel-pad stack" style={{ maxWidth: 680 }} onSubmit={submit}>
        <label className="field">
          <span>What’s the problem?</span>
          <input className="input" required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Kitchen sink is leaking" />
        </label>
        <label className="field">
          <span>Details</span>
          <textarea className="textarea" required minLength={5} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Where exactly is it, when did it start, is it getting worse?" />
        </label>
        <div className="field">
          <span>Photos <span className="faint" style={{ fontWeight: 400 }}>(optional, up to 4)</span></span>
          <div className={`drop ${over ? 'over' : ''}`} role="button" tabIndex={0}
            onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
            <Camera size={22} aria-hidden style={{ margin: '0 auto 6px', display: 'block' }} />
            Take or choose a photo, or drop it here
          </div>
          <input ref={input} type="file" accept={TYPES.join(',')} multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          {fileError && <small style={{ color: 'var(--emergency)' }}>{fileError}</small>}
          {previews.length > 0 && (
            <div className="thumbs">
              {previews.map((u, i) => (
                <figure key={u}>
                  <img src={u} alt={`Photo ${i + 1}`} />
                  <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={13} /></button>
                </figure>
              ))}
            </div>
          )}
        </div>
        <p className="small muted" style={{ margin: 0 }}>If there’s a gas smell, fire or anyone is in danger, leave and call 911 first.</p>
        {error && <ErrorBox message={errorMessage(error)} />}
        <div><button className="btn btn-primary" disabled={isLoading}>{isLoading ? 'Sending…' : 'Send request'}</button></div>
      </form>
    </>
  );
}
