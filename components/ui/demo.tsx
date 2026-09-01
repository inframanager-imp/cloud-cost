'use client';
import { useState, ChangeEvent, FormEvent, ReactNode } from 'react';
import Image from 'next/image';
import {
  Ripple,
  AuthTabs,
  TechOrbitDisplay,
} from '@/components/ui/modern-animated-sign-in';

type FormData = {
  email: string;
  password: string;
};

interface OrbitIcon {
  component: () => ReactNode;
  className: string;
  duration?: number;
  delay?: number;
  radius?: number;
  path?: boolean;
  reverse?: boolean;
}

// Configured with the project's official logos from /static/img/
const iconsArray: OrbitIcon[] = [
  {
    // AWS Cloud
    component: () => (
      <div className="flex items-center justify-center p-2 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={36}
          height={36}
          src="/static/img/aws-logo.svg"
          alt="Amazon Web Services"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[54px] border-none bg-transparent',
    duration: 25,
    delay: 0,
    radius: 110,
    path: true,
    reverse: false,
  },
  {
    // Microsoft Azure
    component: () => (
      <div className="flex items-center justify-center p-2 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={34}
          height={34}
          src="/static/img/azure-logo.svg"
          alt="Microsoft Azure"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[54px] border-none bg-transparent',
    duration: 25,
    delay: 8,
    radius: 110,
    path: true,
    reverse: false,
  },
  {
    // Google Cloud Platform (GCP)
    component: () => (
      <div className="flex items-center justify-center p-2 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={34}
          height={34}
          src="/static/img/gcp-logo.svg"
          alt="Google Cloud Platform"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[54px] border-none bg-transparent',
    duration: 25,
    delay: 16,
    radius: 110,
    path: true,
    reverse: false,
  },
  {
    // OpenAI Cost Telemetry
    component: () => (
      <div className="flex items-center justify-center p-2.5 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={32}
          height={32}
          src="/static/img/openai-logo.svg"
          alt="OpenAI"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[50px] border-none bg-transparent',
    radius: 190,
    duration: 32,
    delay: 0,
    path: true,
    reverse: true,
  },
  {
    // Atlassian Cloud / Jira
    component: () => (
      <div className="flex items-center justify-center p-2.5 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={30}
          height={30}
          src="/static/img/atlassian-logo.svg"
          alt="Atlassian"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[50px] border-none bg-transparent',
    radius: 190,
    duration: 32,
    delay: 10,
    path: true,
    reverse: true,
  },
  {
    // Cursor AI
    component: () => (
      <div className="flex items-center justify-center p-2.5 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={30}
          height={30}
          src="/static/img/cursor-logo.svg"
          alt="Cursor"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[50px] border-none bg-transparent',
    radius: 190,
    duration: 32,
    delay: 20,
    path: true,
    reverse: true,
  },
  {
    // TrueTec Systems Core Engine
    component: () => (
      <div className="flex items-center justify-center p-3 rounded-full bg-white/95 shadow-lg border-2 border-indigo-500/40 dark:bg-zinc-900/95">
        <Image
          width={38}
          height={38}
          src="/static/img/truetec-icon.png"
          alt="TrueTec FinOps"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[62px] border-none bg-transparent',
    radius: 270,
    duration: 40,
    delay: 0,
    path: true,
    reverse: false,
  },
  {
    // ChatGPT AI Integration
    component: () => (
      <div className="flex items-center justify-center p-2.5 rounded-full bg-white/90 shadow-md border border-slate-200/80 dark:bg-zinc-900/90 dark:border-zinc-700">
        <Image
          width={32}
          height={32}
          src="/static/img/chatgpt-logo.svg"
          alt="ChatGPT"
          className="object-contain"
        />
      </div>
    ),
    className: 'size-[52px] border-none bg-transparent',
    radius: 270,
    duration: 40,
    delay: 20,
    path: true,
    reverse: false,
  },
];

export function Demo() {
  const [formData, setFormData] = useState<FormData>({
    email: '',
    password: '',
  });

  const goToForgotPassword = (
    event: React.MouseEvent<HTMLButtonElement | HTMLAnchorElement>
  ) => {
    event.preventDefault();
    console.log('forgot password');
  };

  const handleInputChange = (
    event: ChangeEvent<HTMLInputElement>,
    name: keyof FormData
  ) => {
    const value = event.target.value;

    setFormData((prevState) => ({
      ...prevState,
      [name]: value,
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log('Form submitted', formData);
  };

  const formFields = {
    header: 'Welcome back',
    subHeader: 'Sign in to your Cloud Cost Analyzer account',
    fields: [
      {
        label: 'Work email',
        required: true,
        type: 'email' as const,
        placeholder: 'name@company.com',
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          handleInputChange(event, 'email'),
      },
      {
        label: 'Password',
        required: true,
        type: 'password' as const,
        placeholder: '••••••••',
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          handleInputChange(event, 'password'),
      },
    ],
    submitButton: 'Sign in to Console',
    textVariantButton: 'Forgot password?',
  };

  return (
    <section className='flex max-lg:justify-center w-full min-h-screen bg-neutral-50 dark:bg-zinc-950'>
      {/* Left Side: Orbiting Cloud & AI Cost Integrations */}
      <span className='relative flex flex-col justify-center w-1/2 max-lg:hidden overflow-hidden'>
        <Ripple mainCircleSize={120} />
        <TechOrbitDisplay
          iconsArray={iconsArray}
          text={'CLOUD COST\nANALYZER'}
        />
      </span>

      {/* Right Side: Auth Form */}
      <span className='w-1/2 h-[100dvh] flex flex-col justify-center items-center max-lg:w-full max-lg:px-[10%] z-10'>
        <AuthTabs
          formFields={formFields}
          goTo={goToForgotPassword}
          handleSubmit={handleSubmit}
        />
      </span>
    </section>
  );
}

export default Demo;
