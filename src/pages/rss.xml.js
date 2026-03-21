import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
	const posts = await getCollection('blog');
	return rss({
		title: 'Greg Caban',
		description: 'Greg Caban\'s blog',
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.pubDate,
			description: post.data.description,
			link: `/blog/${post.id}/`,
		})),
		customData: `<language>en-us</language>`,
	});
}
