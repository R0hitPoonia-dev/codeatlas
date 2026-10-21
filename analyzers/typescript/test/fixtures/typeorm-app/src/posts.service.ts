import { Repository } from "typeorm";
import { BlogPost } from "./post.entity";

export class PostsService {
  constructor(private readonly posts: Repository<BlogPost>) {}

  list() {
    return this.posts.find();
  }

  publish(post: BlogPost) {
    return this.posts.save(post);
  }
}
