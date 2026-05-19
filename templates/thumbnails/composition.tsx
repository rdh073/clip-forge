// Remotion composition for ClipForge thumbnails.
// Render with: npx remotion render composition.tsx ThumbnailMain out.png
//
// Renders a 1080x1920 frame with a still image background, a brand gradient
// strip, and a heavy headline. Designed to look good both as a YouTube Shorts
// thumbnail (1280x720 cropped) and as a TikTok cover (9:16 full).

import { AbsoluteFill, Img, Composition } from 'remotion';

type Props = {
  title: string;
  clip_id: string;
  colors: { primary: string; accent: string };
  still_url?: string;
};

export const Thumbnail: React.FC<Props> = ({ title, clip_id, colors, still_url }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {still_url && (
        <Img src={still_url} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.65 }} />
      )}
      <AbsoluteFill style={{
        background: `linear-gradient(180deg, transparent 0%, transparent 55%, ${colors.primary}cc 85%, ${colors.primary} 100%)`,
      }} />
      <AbsoluteFill style={{
        padding: 80,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}>
        <div style={{
          fontFamily: 'Inter, Geist, Arial',
          fontWeight: 900,
          color: '#ffffff',
          fontSize: 96,
          lineHeight: 1.05,
          textShadow: `0 4px 24px rgba(0,0,0,0.6)`,
          letterSpacing: -1,
        }}>
          {title}
        </div>
        <div style={{
          marginTop: 24,
          color: colors.accent,
          fontFamily: 'Inter',
          fontWeight: 800,
          fontSize: 36,
          letterSpacing: 3,
          textTransform: 'uppercase',
        }}>
          ClipForge · {clip_id}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="ThumbnailMain"
    component={Thumbnail}
    durationInFrames={1}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{
      title: 'Nobody tells you this',
      clip_id: 'c01',
      colors: { primary: '#ff0066', accent: '#00d4ff' },
    }}
  />
);
